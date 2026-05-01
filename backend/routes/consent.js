/**
 * Noticeify — routes/consent.js
 *
 * POST /api/v1/consent
 *   Receives consent events from consent-logger.js (client-side).
 *   Validates, enriches (IP geolocation, hash), and persists.
 *
 * GET  /api/v1/consent/:clientId
 *   Returns paginated consent event log for dashboard.
 *
 * GET  /api/v1/consent/stats/:clientId
 *   Returns aggregated consent rate metrics for the dashboard charts.
 *
 * GET  /api/v1/consent/export/:clientId
 *   CSV export of the consent log (for legal/audit use).
 */

import { Router }   from 'express';
import crypto       from 'crypto';
import { query, withClient, setClientContext } from '../db/pool.js';
import { requireAuth, validateOrigin }         from '../middleware/auth.js';

const router = Router();

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_SOURCES = new Set([
  'banner', 'preference_center', 'api', 'withdrawal', 'gpc'
]);

const ALLOWED_CATS = [
  'functional', 'analytics', 'marketing',
  'personalization', 'support', 'media'
];

const GEO_LOOKUP_TIMEOUT_MS = parseInt(process.env.GEO_LOOKUP_TIMEOUT_MS || '1200', 10);
const GEOIP_ENDPOINT = process.env.GEOIP_ENDPOINT || 'https://ipapi.co';

/**
 * Validate the incoming consent payload from consent-logger.js.
 * Returns { valid: true, data } or { valid: false, errors: [...] }.
 *
 * @param {object} body — raw request body
 */
function validatePayload(body) {
  const errors = [];

  if (!body.consentId || typeof body.consentId !== 'string' || body.consentId.length > 64) {
    errors.push('consentId: required string, max 64 chars');
  }
  if (!body.clientId || typeof body.clientId !== 'string') {
    errors.push('clientId: required string');
  }
  if (!body.timestamp || isNaN(Date.parse(body.timestamp))) {
    errors.push('timestamp: required ISO 8601 string');
  }

  // Reject timestamps more than 24h in the future (clock skew / replay attack)
  const consentedAt = new Date(body.timestamp);
  if (consentedAt > new Date(Date.now() + 86_400_000)) {
    errors.push('timestamp: must not be in the future');
  }

  if (!VALID_SOURCES.has(body.source)) {
    errors.push(`source: must be one of ${[...VALID_SOURCES].join(', ')}`);
  }
  if (body.version && typeof body.version !== 'string') {
    errors.push('version: must be a string');
  }

  // categories can be null for withdrawal events
  if (body.source !== 'withdrawal' && body.categories) {
    if (typeof body.categories !== 'object') {
      errors.push('categories: must be an object');
    }
  }

  // URL — strip query params to reduce PII exposure if they contain order data etc.
  let cleanPageUrl = null;
  if (body.pageUrl) {
    try {
      const u = new URL(body.pageUrl);
      // Keep path but strip query string and fragment (may contain PII)
      cleanPageUrl = u.origin + u.pathname;
    } catch (_) {
      cleanPageUrl = null; // malformed URL — don't store it
    }
  }

  if (errors.length) return { valid: false, errors };

  return {
    valid: true,
    data: {
      consentId:     body.consentId,
      clientId:      body.clientId,
      previousId:    body.previousConsentId || null,
      sdkVersion:    typeof body.sdkVersion === 'string' ? body.sdkVersion.slice(0, 20) : '0.0.0',
      consentVersion: typeof body.version === 'string' ? body.version.slice(0, 20) : '1.0',
      consentedAt:   consentedAt.toISOString(),
      source:        body.source,
      categories:    body.categories || null,
      gpcDetected:   body.gpcDetected === true,
      doNotTrack:    body.doNotTrack   === true,
      pageUrl:       cleanPageUrl,
      referrer:      typeof body.referrer === 'string' ? body.referrer.slice(0, 500) : null,
      userAgent:     typeof body.userAgent === 'string' ? body.userAgent.slice(0, 512) : null,
      language:      typeof body.language === 'string' ? body.language.slice(0, 10) : null,
      viewportWidth:  Number.isInteger(body.viewportWidth)  ? body.viewportWidth  : null,
      viewportHeight: Number.isInteger(body.viewportHeight) ? body.viewportHeight : null,
    },
  };
}

// ---------------------------------------------------------------------------
// IP anonymization
//
// We hash the IP with a daily salt so:
//   - The same IP on the same day produces the same hash (dedup, rate limiting)
//   - The same IP on different days produces a different hash (no long-term tracking)
//   - Raw IPs are never stored
// ---------------------------------------------------------------------------

function hashIp(ip) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const salt   = process.env.IP_HASH_SALT;
  if (!salt) {
    throw new Error('IP_HASH_SALT is not configured');
  }
  return crypto
    .createHmac('sha256', salt + today)
    .update(ip || '')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Geo lookup
//
// HTTP-based lookup (defaults to ipapi.co, configurable via GEOIP_ENDPOINT).
// Fails open to null values to keep consent ingestion fast and reliable.
//
// Returns { countryCode, regionCode } or nulls if lookup fails.
// ---------------------------------------------------------------------------

async function geoLookup(ip) {
  if (!ip || ip === '::1' || ip === '127.0.0.1') {
    return { countryCode: null, regionCode: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEO_LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(`${GEOIP_ENDPOINT}/${encodeURIComponent(ip)}/json/`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return { countryCode: null, regionCode: null };
    }

    const data = await res.json();
    return {
      countryCode: typeof data?.country_code === 'string'
        ? data.country_code.toUpperCase().slice(0, 2)
        : null,
      regionCode: typeof data?.region_code === 'string'
        ? data.region_code.toUpperCase().slice(0, 8)
        : null,
    };
  } catch (_) {
    return { countryCode: null, regionCode: null };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/consent
// ---------------------------------------------------------------------------

router.post(
  '/',
  requireAuth('consent:write'),
  validateOrigin,
  async (req, res) => {

    const { valid, errors, data } = validatePayload(req.body);

    if (!valid) {
      return res.status(400).json({ error: 'validation_error', details: errors });
    }

    // Verify the clientId in the payload matches the authenticated key
    if (data.clientId !== req.auth.clientId) {
      return res.status(403).json({
        error:   'client_mismatch',
        message: 'Payload clientId does not match the authenticated API key.',
      });
    }

    // Extract client IP (trust X-Forwarded-For only if behind a known proxy)
    const rawIp = req.ip ||
      (process.env.TRUST_PROXY ? req.headers['x-forwarded-for']?.split(',')[0]?.trim() : null);

    const ipHash          = hashIp(rawIp);
    const { countryCode, regionCode } = await geoLookup(rawIp);

    // Extract per-category booleans (null-safe for withdrawal events)
    const cats = data.categories || {};

    try {
      await withClient(async (client) => {
        // Set RLS context
        await setClientContext(client, data.clientId);

        // Idempotent insert — ON CONFLICT DO NOTHING via the DB function
        await client.query(
          `SELECT insert_consent_event_idempotent(
            $1,$2,$3,$4,$5,$6,$7,
            $8,$9,$10,$11,$12,$13,
            $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
          )`,
          [
            data.consentId,
            data.clientId,
            data.previousId,
            data.sdkVersion,
            data.consentVersion,
            data.consentedAt,
            data.source,
            cats.functional      ?? null,
            cats.analytics       ?? null,
            cats.marketing       ?? null,
            cats.personalization ?? null,
            cats.support         ?? null,
            cats.media           ?? null,
            data.gpcDetected,
            data.doNotTrack,
            data.pageUrl,
            data.referrer,
            data.userAgent,
            data.language,
            data.viewportWidth,
            data.viewportHeight,
            ipHash,
            countryCode,
            regionCode,
          ]
        );
      });

      // 204 No Content — success, nothing to return to the browser script
      return res.status(204).send();

    } catch (err) {
      console.error('[POST /consent] DB error:', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/consent/:clientId — paginated event log (dashboard)
// ---------------------------------------------------------------------------

router.get(
  '/:clientId',
  requireAuth('logs:read'),
  async (req, res) => {
    const { clientId } = req.params;

    if (clientId !== req.auth.clientId && !req.auth.scopes.includes('admin')) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // Pagination
    const limit  = Math.min(parseInt(req.query.limit  || '50',  10), 500);
    const cursor = req.query.cursor; // ISO timestamp of last item (keyset pagination)

    // Filters
    const source      = req.query.source;      // 'banner' | 'withdrawal' | etc.
    const gpcOnly     = req.query.gpc === 'true';
    const dateFrom    = req.query.from;        // ISO date string
    const dateTo      = req.query.to;

    const params  = [clientId, limit + 1]; // fetch one extra to detect next page
    const where   = ['client_id = $1'];
    let   pIndex  = 3;

    if (cursor) { where.push(`received_at < $${pIndex++}`); params.push(cursor); }
    if (source) { where.push(`source = $${pIndex++}`);      params.push(source); }
    if (gpcOnly){ where.push(`gpc_detected = TRUE`); }
    if (dateFrom){ where.push(`received_at >= $${pIndex++}`); params.push(dateFrom); }
    if (dateTo)  { where.push(`received_at <= $${pIndex++}`); params.push(dateTo); }

    const sql = `
      SELECT
        consent_id, source, consented_at, received_at,
        cat_functional, cat_analytics, cat_marketing,
        cat_personalization, cat_support, cat_media,
        gpc_detected, page_url, country_code, sdk_version
      FROM consent_events
      WHERE ${where.join(' AND ')}
      ORDER BY received_at DESC
      LIMIT $2
    `;

    try {
      const result = await query(sql, params);
      const rows   = result.rows;
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();

      return res.json({
        events:  rows,
        hasMore,
        nextCursor: hasMore ? rows[rows.length - 1].received_at : null,
        count:   rows.length,
      });
    } catch (err) {
      console.error('[GET /consent] DB error:', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/consent/stats/:clientId — dashboard metrics
// ---------------------------------------------------------------------------

router.get(
  '/stats/:clientId',
  requireAuth('logs:read'),
  async (req, res) => {
    const { clientId } = req.params;
    const days = Math.min(parseInt(req.query.days || '30', 10), 365);

    if (clientId !== req.auth.clientId && !req.auth.scopes.includes('admin')) {
      return res.status(403).json({ error: 'forbidden' });
    }

    try {
      // Pull from materialized view for speed
      const daily = await query(
        `SELECT day, total_events, pct_accept_all, pct_reject_all,
                pct_custom_prefs, pct_analytics, pct_marketing,
                pct_functional, pct_gpc, withdrawal_events
         FROM v_consent_rates_daily
         WHERE client_id = $1
           AND day >= NOW() - ($2 || ' days')::INTERVAL
         ORDER BY day DESC`,
        [clientId, days]
      );

      // 7-day summary (live query for freshness)
      const summary = await query(
        `SELECT
           COUNT(*)                          AS total_7d,
           ROUND(100.0 * AVG(CASE WHEN cat_analytics = TRUE THEN 1 ELSE 0 END)::NUMERIC, 1)
                                             AS pct_analytics,
           ROUND(100.0 * AVG(CASE WHEN cat_marketing = TRUE THEN 1 ELSE 0 END)::NUMERIC, 1)
                                             AS pct_marketing,
           ROUND(100.0 * COUNT(*) FILTER (WHERE gpc_detected) / NULLIF(COUNT(*),0)::NUMERIC, 1)
                                             AS pct_gpc,
           COUNT(*) FILTER (WHERE source = 'withdrawal')
                                             AS withdrawals_7d
         FROM consent_events
         WHERE client_id = $1
           AND received_at >= NOW() - INTERVAL '7 days'`,
        [clientId]
      );

      // Scripts firing before consent (from latest scanner run)
      const preConsent = await query(
        `SELECT COUNT(*) AS count
         FROM scanner_findings sf
         JOIN scanner_runs sr ON sr.id = sf.scan_run_id
         WHERE sf.client_id = $1
           AND sf.fires_before_consent = TRUE
           AND sr.status = 'completed'
           AND sr.id = (
             SELECT id FROM scanner_runs
             WHERE client_id = $1 AND status = 'completed'
             ORDER BY completed_at DESC LIMIT 1
           )`,
        [clientId]
      );

      return res.json({
        summary:         summary.rows[0],
        daily:           daily.rows,
        preConsentCount: parseInt(preConsent.rows[0]?.count || '0', 10),
      });

    } catch (err) {
      console.error('[GET /consent/stats] DB error:', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/consent/export/:clientId — CSV export for audit/legal
// ---------------------------------------------------------------------------

router.get(
  '/export/:clientId',
  requireAuth('logs:export'),
  async (req, res) => {
    const { clientId } = req.params;

    if (clientId !== req.auth.clientId && !req.auth.scopes.includes('admin')) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const dateFrom = req.query.from || new Date(Date.now() - 30 * 86400_000).toISOString();
    const dateTo   = req.query.to   || new Date().toISOString();

    try {
      const result = await query(
        `SELECT
           consent_id, source, consented_at, received_at,
           sdk_version, consent_version,
           cat_functional, cat_analytics, cat_marketing,
           cat_personalization, cat_support, cat_media,
           gpc_detected, do_not_track,
           page_url, country_code, language
         FROM consent_events
         WHERE client_id = $1
           AND received_at BETWEEN $2 AND $3
         ORDER BY received_at DESC
         LIMIT 50000`,  // hard cap for memory safety
        [clientId, dateFrom, dateTo]
      );

      // Stream CSV
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',
        `attachment; filename="consent_log_${clientId}_${dateFrom.slice(0,10)}.csv"`);

      // Header row
      const cols = [
        'consent_id','source','consented_at','received_at',
        'sdk_version','consent_version',
        'cat_functional','cat_analytics','cat_marketing',
        'cat_personalization','cat_support','cat_media',
        'gpc_detected','do_not_track','page_url','country_code','language'
      ];
      res.write(cols.join(',') + '\n');

      // Data rows
      for (const row of result.rows) {
        const line = cols.map(col => {
          const v = row[col];
          if (v === null || v === undefined) return '';
          const str = String(v);
          // Escape CSV: wrap in quotes if contains comma, quote, or newline
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
          }
          return str;
        }).join(',');
        res.write(line + '\n');
      }

      res.end();

    } catch (err) {
      console.error('[GET /consent/export] DB error:', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  }
);

export default router;
