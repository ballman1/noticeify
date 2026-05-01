import test from 'node:test';
import assert from 'node:assert/strict';

import { createScannerWorker } from '../scanner/worker.js';

test('worker claim cycle marks pending run as running then processes it', async () => {
  const calls = [];
  let claimed = false;

  const queryFn = async (sql) => {
    calls.push(sql);
    if (sql.includes('SET status = \'pending\'')) {
      return { rows: [] };
    }
    if (sql.includes('SET status = \'running\'')) {
      if (claimed) return { rows: [] };
      claimed = true;
      return {
        rows: [{ id: 'run_1', client_id: 'client_1', domain: 'example.com' }],
      };
    }
    if (sql.includes('SET result_json')) {
      return { rows: [] };
    }
    return { rows: [] };
  };

  const fakeRun = async (_run, q) => {
    await q("UPDATE scanner_runs SET result_json = '{}' WHERE id = 'run_1'");
  };
  const injectedWorker = createScannerWorker({ queryFn, runScanJobFn: fakeRun });
  await injectedWorker.startScannerWorker();

  assert.equal(claimed, true);
  assert.ok(calls.some((s) => s.includes('SET status = \'running\'')));
  assert.ok(calls.some((s) => s.includes('SET result_json')));
});

test('worker startup recovery query is executed', async () => {
  const calls = [];
  const queryFn = async (sql) => {
    calls.push(sql);
    return { rows: [] };
  };

  const worker = createScannerWorker({ queryFn, runScanJobFn: async () => {} });
  await worker.startScannerWorker();

  assert.ok(
    calls.some((s) => s.includes('Recovered stale running scan on worker startup'))
  );
});
