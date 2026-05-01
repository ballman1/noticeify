import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createScannerRouter } from '../routes/scanner.js';

function allowAuth() {
  return (req, _res, next) => {
    req.auth = { clientId: 'client_1', scopes: ['scanner:run', 'scanner:read'] };
    next();
  };
}

function denyOtherClientAuth() {
  return (req, _res, next) => {
    req.auth = { clientId: 'other_client', scopes: ['scanner:run', 'scanner:read'] };
    next();
  };
}

test('POST /run/:clientId enqueues a pending run and returns 202', async () => {
  const calls = [];
  let kicked = false;

  const queryFn = async (sql) => {
    calls.push(sql);
    if (sql.includes('FROM clients')) return { rows: [{ id: 'client_1', domain: 'example.com' }] };
    if (sql.includes("status IN ('pending','running')")) return { rows: [] };
    if (sql.includes('INSERT INTO scanner_runs')) return { rows: [{ id: 'run_123' }] };
    return { rows: [] };
  };

  const app = express();
  app.use(express.json());
  app.use('/api/v1/scanner', createScannerRouter({
    queryFn,
    requireAuthFn: allowAuth,
    kickScannerWorkerFn: async () => { kicked = true; },
  }));

  const server = app.listen(0);
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/api/v1/scanner/run/client_1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ triggeredBy: 'test' }),
  });

  const body = await res.json();
  server.close();

  assert.equal(res.status, 202);
  assert.equal(body.scanRunId, 'run_123');
  assert.equal(body.status, 'pending');
  assert.equal(kicked, true);
  assert.ok(calls.some((s) => s.includes('INSERT INTO scanner_runs')));
});

test('POST /run/:clientId returns 409 when a scan is already running', async () => {
  const queryFn = async (sql) => {
    if (sql.includes('FROM clients')) return { rows: [{ id: 'client_1', domain: 'example.com' }] };
    if (sql.includes("status IN ('pending','running')")) return { rows: [{ id: 'run_existing' }] };
    return { rows: [] };
  };

  const app = express();
  app.use(express.json());
  app.use('/api/v1/scanner', createScannerRouter({
    queryFn,
    requireAuthFn: allowAuth,
    kickScannerWorkerFn: async () => {},
  }));

  const server = app.listen(0);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/scanner/run/client_1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ triggeredBy: 'test' }),
  });
  const body = await res.json();
  server.close();

  assert.equal(res.status, 409);
  assert.equal(body.error, 'scan_in_progress');
  assert.equal(body.scanRunId, 'run_existing');
});

test('POST /run/:clientId returns 403 for client mismatch', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/scanner', createScannerRouter({
    queryFn: async () => ({ rows: [] }),
    requireAuthFn: denyOtherClientAuth,
    kickScannerWorkerFn: async () => {},
  }));

  const server = app.listen(0);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/scanner/run/client_1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ triggeredBy: 'test' }),
  });
  const body = await res.json();
  server.close();

  assert.equal(res.status, 403);
  assert.equal(body.error, 'forbidden');
});

test('POST /run/:clientId returns 404 when client does not exist', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/scanner', createScannerRouter({
    queryFn: async (sql) => {
      if (sql.includes('FROM clients')) return { rows: [] };
      return { rows: [] };
    },
    requireAuthFn: allowAuth,
    kickScannerWorkerFn: async () => {},
  }));

  const server = app.listen(0);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/scanner/run/client_1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ triggeredBy: 'test' }),
  });
  const body = await res.json();
  server.close();

  assert.equal(res.status, 404);
  assert.equal(body.error, 'client_not_found');
});

test('PATCH /runs/:scanRunId returns 400 for invalid status value', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/scanner', createScannerRouter({
    queryFn: async () => ({ rows: [{ client_id: 'client_1' }] }),
    requireAuthFn: allowAuth,
    kickScannerWorkerFn: async () => {},
  }));

  const server = app.listen(0);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/scanner/runs/run_1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'not_a_real_status' }),
  });
  const body = await res.json();
  server.close();

  assert.equal(res.status, 400);
  assert.equal(body.error, 'invalid_status');
});

test('PATCH /runs/:scanRunId returns 204 for valid status update', async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/v1/scanner', createScannerRouter({
    queryFn: async (sql) => {
      calls.push(sql);
      if (sql.startsWith('SELECT client_id FROM scanner_runs')) {
        return { rows: [{ client_id: 'client_1' }] };
      }
      return { rows: [] };
    },
    requireAuthFn: allowAuth,
    kickScannerWorkerFn: async () => {},
  }));

  const server = app.listen(0);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/scanner/runs/run_1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'completed' }),
  });
  server.close();

  assert.equal(res.status, 204);
  assert.ok(calls.some((s) => s.includes('UPDATE scanner_runs SET')));
});

test('GET /runs/:scanRunId hides results unless status is completed', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/scanner', createScannerRouter({
    queryFn: async (sql) => {
      if (sql.includes('FROM scanner_runs')) {
        return {
          rows: [{
            id: 'run_1',
            client_id: 'client_1',
            status: 'running',
            triggered_by: 'manual',
            urls_crawled: 3,
            started_at: new Date().toISOString(),
            completed_at: null,
            error_message: null,
            result_json: { hidden: true },
          }],
        };
      }
      return { rows: [] };
    },
    requireAuthFn: allowAuth,
    kickScannerWorkerFn: async () => {},
  }));

  const server = app.listen(0);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/scanner/runs/run_1`);
  const body = await res.json();
  server.close();

  assert.equal(res.status, 200);
  assert.equal(body.status, 'running');
  assert.equal(body.results, null);
});
