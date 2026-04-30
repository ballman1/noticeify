/**
 * Noticeify — routes/scanner.js
 *
 * POST /api/v1/scanner/run/:clientId
 *   Triggers a new site scan. Returns immediately with a scanRunId.
 *   The scan runs in the background (worker process or job queue).
 *   Poll GET /api/v1/scanner/runs/:scanRunId for status.
 *
 * GET  /api/v1/scanner/runs/:scanRunId
 *   Returns status and results for a specific scan run.
 *
 * GET  /api/v1/scanner/latest/:clientId
 *   Returns the most recent completed scan report for a client.
 *   This is what the dashboard "Scanner" tab loads.
 *
 * GET  /api/v1/scanner/history/:clientId
 *   Returns a list of past scan runs with summary stats.
 */

import { Router }     from 'express';
import crypto         from 'crypto';
import { query, withClient, setClientContext } from '../db/pool.js';
import { requireAuth }                         from '../middleware/auth.js';
import { runSiteScan }                         from '../../scanner/core/site-crawler.js';
import { formatDashboardPayload, formatTextSummary } from '../../scanner/reporters/scan-reporter.js';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/v1/scanner/run/:clientId — trigger a scan
// ---------------------------------------------------------------------------

router.post(
  '/run/:clientId',
  requireAuth('scanner:run'),
  async (req, res) => {
    const { clientId } = req.params;

    if (clientId !== req.auth.clientId && !req.auth.scopes.includes('admin')) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // Look up client config
    const clientResult = await query(
      `SELECT id, domain, client_key FROM clients WHERE id = $1 AND deleted_at IS NULL`,
      [clientId]
    );
    if (!clientResult.rows.length) {
      return res.status(404).json({ error: 'client_not_found' });
    }
    const client = clientResult.rows[0];

    // Check if a scan is already running
    const running = await query(
      `SELECT id FROM scanner_runs
       WHERE client_id = $1 AND status IN ('pending','running')
       LIMIT 1`,
      [clientId]
    );
    if (running.rows.length) {
      return res.status(409).json({
        error:      'scan_in_progress',
        scanRunId:  running.rows[0].id,
        message:    'A scan is already running for this client.',
      });
    }

    // Create the scanner_runs row
    const triggeredBy = req.body?.triggeredBy || 'manual';
    const runResult = await query(
      `INSERT INTO scanner_runs (client_id, triggered_by, status)
       VALUES ($1, $2, 'pending')
       RETURNING id`,
      [clientId, triggeredBy]
    );
    const scanRunId = runResult.rows[0].id;

    // Return immediately — scan runs async
    res.status(202).json({
      scanRunId,
      status:  'pending',
      message: 'Scan started. Poll GET /api/v1/scanner/runs/:scanRunId for status.',
    });

    // Run scan in background (fire and forget)
    // In production, push to a job queue (BullMQ, pg-boss) instead of setImmediate
    setImmediate(async () => {
      const startTime = Date.now();
      try {
        const baseUrl = `https://${client.domain}`;
        const report  = await runSiteScan({
          clientId,
          scanRunId,
          baseUrl,
          clientDomain: client.domain,
          onProgress:   (msg) => console.log(`[Scanner:${scanRunId}] ${msg}`),
        });

        // Store the formatted dashboard payload on the run record
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
        console.error(`[Scanner:${scanRunId}] Fatal error:`, err.message);
        await query(
          `UPDATE scanner_runs
           SET status = 'failed', error_message = $1, completed_at = NOW()
           WHERE id = $2`,
          [err.message.slice(0, 500), scanRunId]
        );
      }
    });
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/scanner/runs/:scanRunId — poll scan status
// ---------------------------------------------------------------------------

router.get(
  '/runs/:scanRunId',
  requireAuth('scanner:read'),
  async (req, res) => {
    const { scanRunId } = req.params;

    const result = await query(
      `SELECT id, client_id, status, triggered_by, urls_crawled,
              started_at, completed_at, error_message, result_json
       FROM scanner_runs
       WHERE id = $1`,
      [scanRunId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'scan_run_not_found' });
    }

    const run = result.rows[0];

    // Auth: ensure requester owns this client
    if (run.client_id !== req.auth.clientId && !req.auth.scopes.includes('admin')) {
      return res.status(403).json({ error: 'forbidden' });
    }

    return res.json({
      scanRunId:    run.id,
      status:       run.status,
      triggeredBy:  run.triggered_by,
      urlsCrawled:  run.urls_crawled,
      startedAt:    run.started_at,
      completedAt:  run.completed_at,
      error:        run.error_message || null,
      // Only include full results when complete
      results:      run.status === 'completed' && run.result_json
                      ? run.result_json
                      : null,
    });
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/scanner/latest/:clientId — most recent completed scan
// ---------------------------------------------------------------------------

router.get(
  '/latest/:clientId',
  requireAuth('scanner:read'),
  async (req, res) => {
    const { clientId } = req.params;

    if (clientId !== req.auth.clientId && !req.auth.scopes.includes('admin')) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const result = await query(
      `SELECT id, status, urls_crawled, started_at, completed_at, result_json
       FROM scanner_runs
       WHERE client_id = $1 AND status = 'completed'
       ORDER BY completed_at DESC
       LIMIT 1`,
      [clientId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error:   'no_scan_found',
        message: 'No completed scans found. Trigger a scan first.',
      });
    }

    const run = result.rows[0];
    return res.json({
      scanRunId:   run.id,
      urlsCrawled: run.urls_crawled,
      completedAt: run.completed_at,
      results:     run.result_json,
    });
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/scanner/history/:clientId — scan run list
// ---------------------------------------------------------------------------

router.get(
  '/history/:clientId',
  requireAuth('scanner:read'),
  async (req, res) => {
    const { clientId } = req.params;
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);

    if (clientId !== req.auth.clientId && !req.auth.scopes.includes('admin')) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const result = await query(
      `SELECT
         sr.id, sr.status, sr.triggered_by, sr.urls_crawled,
         sr.started_at, sr.completed_at, sr.error_message,
         COUNT(sf.id) FILTER (WHERE sf.fires_before_consent) AS pre_consent_count,
         COUNT(sf.id) FILTER (WHERE sf.risk_level = 'critical') AS critical_count
       FROM scanner_runs sr
       LEFT JOIN scanner_findings sf ON sf.scan_run_id = sr.id
       WHERE sr.client_id = $1
       GROUP BY sr.id
       ORDER BY sr.created_at DESC
       LIMIT $2`,
      [clientId, limit]
    );

    return res.json({ runs: result.rows });
  }
);

// ---------------------------------------------------------------------------
// Add result_json column to scanner_runs if not exists
// (Run this as a one-off migration if needed)
// ---------------------------------------------------------------------------
// ALTER TABLE scanner_runs ADD COLUMN IF NOT EXISTS result_json JSONB;


// ---------------------------------------------------------------------------
// PATCH /api/v1/scanner/runs/:scanRunId — update run status (used by GitHub Actions)
// ---------------------------------------------------------------------------

router.patch(
  '/runs/:scanRunId',
  requireAuth('scanner:run'),
  async (req, res) => {
    const { scanRunId } = req.params;
    const { status, result_json, error_message } = req.body;

    const allowed = ['running', 'completed', 'failed'];
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ error: 'invalid_status' });
    }

    const run = await query(
      'SELECT client_id FROM scanner_runs WHERE id = $1',
      [scanRunId]
    );
    if (!run.rows.length) return res.status(404).json({ error: 'not_found' });
    if (run.rows[0].client_id !== req.auth.clientId && !req.auth.scopes.includes('admin')) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const fields = [];
    const vals   = [];
    let   i      = 1;
    if (status)       { fields.push(`status = $${i++}`);        vals.push(status); }
    if (result_json)  { fields.push(`result_json = $${i++}`);   vals.push(JSON.stringify(result_json)); }
    if (error_message){ fields.push(`error_message = $${i++}`); vals.push(error_message.slice(0,500)); }
    if (status === 'completed' || status === 'failed') {
      fields.push(`completed_at = NOW()`);
    }
    if (!fields.length) return res.status(400).json({ error: 'nothing_to_update' });

    vals.push(scanRunId);
    await query(`UPDATE scanner_runs SET ${fields.join(', ')} WHERE id = $${i}`, vals);
    return res.status(204).send();
  }
);

export default router;
