/**
 * ConsentGuard — middleware/auth.js
 *
 * Two authentication paths:
 *
 *   1. Embed token (Bearer)  — used by the consent.js client script.
 *      These are low-privilege tokens scoped to a single client_id.
 *      They can only write consent events for their own client.
 *      Validated against the api_keys table.
 *
 *   2. Dashboard token (Bearer) — used by the admin dashboard API.
 *      Higher privilege, multiple scopes (logs:read, vendors:write, etc.)
 *      Same api_keys table, different scope set.
 *
 * Rate limiting is handled by middleware/rate-limit.js (separate).
 */

import crypto from 'crypto';
import { query, withClient, setClientContext } from '../db/pool.js';

// ---------------------------------------------------------------------------
// API key validation
// ---------------------------------------------------------------------------

// Cache valid keys for 60 seconds to avoid a DB round-trip on every request.
// Key: raw API key string. Value: { clientId, scopes, expiresAt }.
const KEY_CACHE = new Map();
const CACHE_TTL_MS = 60_000;

function getCached(rawKey) {
  const entry = KEY_CACHE.get(rawKey);
  if (!entry) return null;
  if (Date.now() > entry.cachedAt + CACHE_TTL_MS) {
    KEY_CACHE.delete(rawKey);
    return null;
  }
  return entry;
}

function setCached(rawKey, data) {
  // Prune cache if it grows too large (memory safety)
  if (KEY_CACHE.size > 5000) {
    const oldest = [...KEY_CACHE.entries()]
      .sort((a, b) => a[1].cachedAt - b[1].cachedAt)
      .slice(0, 1000)
      .map(([k]) => k);
    oldest.forEach(k => KEY_CACHE.delete(k));
  }
  KEY_CACHE.set(rawKey, { ...data, cachedAt: Date.now() });
}

/**
 * Validate an API key and return the associated client record.
 * Returns null if the key is invalid, expired, or revoked.
 *
 * @param {string} rawKey
 * @returns {Promise<{clientId: string, scopes: string[]}|null>}
 */
async function validateApiKey(rawKey) {
  if (!rawKey || rawKey.length < 16) return null;

  // Check cache first
  const cached = getCached(rawKey);
  if (cached) return cached.data;

  // Keys are stored as bcrypt hashes — use prefix for the initial lookup
  // then verify the hash. This avoids a full-table scan.
  const prefix = rawKey.slice(0, 8);

  const result = await query(
    `SELECT id, client_id, key_hash, scopes, expires_at, revoked_at
     FROM api_keys
     WHERE key_prefix = $1 AND revoked_at IS NULL`,
    [prefix]
  );

  for (const row of result.rows) {
    // Timing-safe hash comparison using bcrypt
    const hash = hashKey(rawKey);
    if (!crypto.timingSafeEqual(
      Buffer.from(hash),
      Buffer.from(row.key_hash)
    )) continue;

    // Check expiry
    if (row.expires_at && new Date(row.expires_at) < new Date()) continue;

    const data = { clientId: row.client_id, scopes: row.scopes || [] };

    // Update last_used_at (fire-and-forget, don't await)
    query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.id])
      .catch(() => {});

    setCached(rawKey, { data });
    return data;
  }

  // Cache the miss too (prevents hammering DB with invalid keys)
  setCached(rawKey, { data: null });
  return null;
}

/**
 * SHA-256 hash of a raw API key.
 * (In production you'd use bcrypt here — swapped to SHA-256 for Node.js
 *  compatibility without native addons. Replace with bcrypt in production.)
 *
 * @param {string} rawKey
 * @returns {string} hex digest
 */
function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/**
 * requireAuth(scope?)
 *
 * Validates the Authorization: Bearer <key> header.
 * Attaches req.auth = { clientId, scopes } on success.
 * Optionally checks that the key has a required scope.
 *
 * @param {string} [scope] — required scope (e.g. 'consent:write')
 */
function requireAuth(scope) {
  return async (req, res, next) => {
    const header = req.headers['authorization'] || '';
    const [scheme, rawKey] = header.split(' ');

    if (scheme !== 'Bearer' || !rawKey) {
      return res.status(401).json({
        error:   'unauthorized',
        message: 'Authorization: Bearer <api-key> header required.',
      });
    }

    const auth = await validateApiKey(rawKey);
    if (!auth) {
      return res.status(401).json({
        error:   'invalid_api_key',
        message: 'API key is invalid, expired, or revoked.',
      });
    }

    if (scope && !auth.scopes.includes(scope) && !auth.scopes.includes('*')) {
      return res.status(403).json({
        error:   'insufficient_scope',
        message: `This key requires the '${scope}' scope.`,
      });
    }

    req.auth = auth;
    next();
  };
}

/**
 * Validate the request's Origin / Referer against the client's allowed domains.
 * Prevents a rogue site from using a stolen embed key to log consent events
 * against a different client's account.
 */
async function validateOrigin(req, res, next) {
  const { clientId } = req.auth;
  const origin = req.headers['origin'] || req.headers['referer'] || '';

  if (!origin) {
    // No origin header — allow (server-to-server, curl, etc.)
    return next();
  }

  try {
    const originHost = new URL(origin).hostname;

    const result = await query(
      `SELECT domain, additional_domains FROM clients WHERE id = $1`,
      [clientId]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'client_not_found' });
    }

    const { domain, additional_domains } = result.rows[0];
    const allowed = [domain, ...(additional_domains || [])].map(d => d.toLowerCase());

    const isAllowed = allowed.some(d =>
      originHost === d || originHost.endsWith('.' + d)
    );

    if (!isAllowed) {
      console.warn('[Auth] Origin mismatch: clientId=%s origin=%s allowed=%s',
        clientId, originHost, allowed.join(','));
      return res.status(403).json({
        error:   'origin_not_allowed',
        message: 'Request origin does not match client domain configuration.',
      });
    }

    next();
  } catch (err) {
    console.error('[Auth] Origin validation error:', err.message);
    return res.status(400).json({ error: 'invalid_origin' });
  }
}

export { requireAuth, validateOrigin, validateApiKey, hashKey };
