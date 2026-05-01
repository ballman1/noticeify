import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createScannerWorker } from '../scanner/worker.js';

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

const maybeTest = TEST_DATABASE_URL ? test : test.skip;

maybeTest('scanner worker claims one pending run using DB query semantics', async (t) => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();

  const schema = `test_scanner_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);

  try {
    await client.query(`
      CREATE TABLE clients (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        deleted_at TIMESTAMPTZ NULL
      )
    `);

    await client.query(`
      CREATE TABLE scanner_runs (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ NULL,
        completed_at TIMESTAMPTZ NULL,
        triggered_by TEXT NULL,
        result_json JSONB NULL
      )
    `);

    await client.query("INSERT INTO clients (id, domain) VALUES ('client_1', 'example.com')");
    await client.query("INSERT INTO scanner_runs (id, client_id, status) VALUES ('run_1', 'client_1', 'pending')");

    const worker = createScannerWorker({
      queryFn: (sql, params) => client.query(sql, params),
      runScanJobFn: async (_run, queryFn) => {
        await queryFn(
          "UPDATE scanner_runs SET status = 'completed', completed_at = NOW(), result_json = '{}'::jsonb WHERE id = 'run_1'"
        );
      },
    });

    const processed = await worker._processNextPendingScan();
    assert.equal(processed, true);

    const row = await client.query("SELECT status, completed_at FROM scanner_runs WHERE id = 'run_1'");
    assert.equal(row.rows[0].status, 'completed');
    assert.ok(row.rows[0].completed_at);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});

maybeTest('two workers claim different pending runs concurrently', async () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();

  const schema = `test_scanner_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);

  try {
    await client.query(`
      CREATE TABLE clients (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        deleted_at TIMESTAMPTZ NULL
      )
    `);

    await client.query(`
      CREATE TABLE scanner_runs (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ NULL,
        completed_at TIMESTAMPTZ NULL,
        triggered_by TEXT NULL,
        result_json JSONB NULL
      )
    `);

    await client.query("INSERT INTO clients (id, domain) VALUES ('client_1', 'example.com')");
    await client.query("INSERT INTO scanner_runs (id, client_id, status) VALUES ('run_a', 'client_1', 'pending')");
    await client.query("INSERT INTO scanner_runs (id, client_id, status) VALUES ('run_b', 'client_1', 'pending')");

    const processedIds = [];
    const mkWorker = () => createScannerWorker({
      queryFn: (sql, params) => client.query(sql, params),
      runScanJobFn: async (run, queryFn) => {
        processedIds.push(run.id);
        await queryFn(
          `UPDATE scanner_runs
           SET status = 'completed', completed_at = NOW(), result_json = '{}'::jsonb
           WHERE id = $1`,
          [run.id]
        );
      },
    });

    const workerA = mkWorker();
    const workerB = mkWorker();

    const [aProcessed, bProcessed] = await Promise.all([
      workerA._processNextPendingScan(),
      workerB._processNextPendingScan(),
    ]);

    assert.equal(aProcessed, true);
    assert.equal(bProcessed, true);
    assert.equal(new Set(processedIds).size, 2);

    const rows = await client.query(
      "SELECT id, status FROM scanner_runs ORDER BY id ASC"
    );
    assert.deepEqual(rows.rows, [
      { id: 'run_a', status: 'completed' },
      { id: 'run_b', status: 'completed' },
    ]);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
