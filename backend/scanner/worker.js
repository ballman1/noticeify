import { query } from '../db/pool.js';

let workerStarted = false;
let pollHandle = null;
let isProcessing = false;

const POLL_MS = parseInt(process.env.SCANNER_POLL_MS || '5000', 10);
const STALE_RUNNING_MINUTES = parseInt(process.env.SCANNER_STALE_RUNNING_MINUTES || '30', 10);

async function runScanJob(run) {
  const { id: scanRunId, client_id: clientId, domain } = run;
  const startTime = Date.now();
  const baseUrl = `https://${domain}`;

  try {
    const { runSiteScan } = await import('../../scanner/core/site-crawler.js');
    const { formatDashboardPayload, formatTextSummary } =
      await import('../../scanner/reporters/scan-reporter.js');

    const report = await runSiteScan({
      clientId,
      scanRunId,
      baseUrl,
      clientDomain: domain,
      onProgress: (msg) => console.log(`[Scanner:${scanRunId}] ${msg}`),
    });

    const payload = formatDashboardPayload(report, {
      clientId,
      scanRunId,
      baseUrl,
      durationMs: Date.now() - startTime,
    });

    await query(
      `UPDATE scanner_runs
       SET result_json = $1, completed_at = NOW(), status = 'completed'
       WHERE id = $2`,
      [JSON.stringify(payload), scanRunId]
    );

    console.log(formatTextSummary(report, { baseUrl }));
  } catch (err) {
    await query(
      `UPDATE scanner_runs
       SET status = 'failed', error_message = $1, completed_at = NOW()
       WHERE id = $2`,
      [String(err?.message || 'scanner_failed').slice(0, 500), scanRunId]
    );
  }
}

async function processNextPendingScan() {
  const claim = await query(
    `WITH next_run AS (
       SELECT sr.id
       FROM scanner_runs sr
       JOIN clients c ON c.id = sr.client_id
       WHERE sr.status = 'pending'
         AND c.deleted_at IS NULL
       ORDER BY sr.created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE scanner_runs sr
     SET status = 'running', started_at = NOW(), error_message = NULL
     FROM next_run
     WHERE sr.id = next_run.id
     RETURNING sr.id, sr.client_id, sr.triggered_by, sr.started_at,
               (SELECT domain FROM clients WHERE id = sr.client_id) AS domain`,
    []
  );

  if (!claim.rows.length) return false;
  await runScanJob(claim.rows[0]);
  return true;
}

export async function kickScannerWorker() {
  if (!workerStarted) return;
  if (isProcessing) return;
  isProcessing = true;
  try {
    while (await processNextPendingScan()) {
      // drain queue
    }
  } catch (err) {
    console.error('[ScannerWorker] processing error:', err.message);
  } finally {
    isProcessing = false;
  }
}

export async function startScannerWorker() {
  if (workerStarted) return;
  workerStarted = true;

  await query(
    `UPDATE scanner_runs
     SET status = 'pending', error_message = 'Recovered stale running scan on worker startup.'
     WHERE status = 'running'
       AND (
         started_at IS NULL
         OR started_at < NOW() - ($1 || ' minutes')::INTERVAL
       )`,
    [STALE_RUNNING_MINUTES]
  );

  await kickScannerWorker();

  pollHandle = setInterval(() => {
    kickScannerWorker().catch((err) => {
      console.error('[ScannerWorker] poll loop error:', err.message);
    });
  }, POLL_MS);

  if (typeof pollHandle.unref === 'function') {
    pollHandle.unref();
  }
}
