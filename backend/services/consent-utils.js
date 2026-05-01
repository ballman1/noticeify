import crypto from 'crypto';

const VALID_SOURCES = new Set([
  'banner',
  'preference_center',
  'api',
  'withdrawal',
  'gpc',
]);
const ALLOWED_CATEGORIES = new Set([
  'functional',
  'analytics',
  'marketing',
  'personalization',
  'support',
  'media',
]);

const GEO_LOOKUP_TIMEOUT_MS = parseInt(
  process.env.GEO_LOOKUP_TIMEOUT_MS || '1200',
  10
);

const GEOIP_ENDPOINT = process.env.GEOIP_ENDPOINT || 'https://ipapi.co';

/**
 * Validate consent payload shape and normalize selected fields.
 *
 * @param {object} body
 * @returns {{ valid: boolean, errors?: string[], data?: object }}
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

  if (body.source !== 'withdrawal' && body.categories) {
    if (typeof body.categories !== 'object') {
      errors.push('categories: must be an object');
    } else {
      for (const [key, value] of Object.entries(body.categories)) {
        if (!ALLOWED_CATEGORIES.has(key)) {
          errors.push(`categories.${key}: unknown category`);
          continue;
        }
        if (typeof value !== 'boolean') {
          errors.push(`categories.${key}: must be a boolean`);
        }
      }
    }
  }

  let cleanPageUrl = null;
  if (body.pageUrl) {
    try {
      const u = new URL(body.pageUrl);
      cleanPageUrl = u.origin + u.pathname;
    } catch (_) {
      cleanPageUrl = null;
    }
  }

  if (errors.length) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: {
      consentId: body.consentId,
      clientId: body.clientId,
      previousId: body.previousConsentId || null,
      sdkVersion:
        typeof body.sdkVersion === 'string'
          ? body.sdkVersion.slice(0, 20)
          : '0.0.0',
      consentVersion:
        typeof body.version === 'string' ? body.version.slice(0, 20) : '1.0',
      consentedAt: consentedAt.toISOString(),
      source: body.source,
      categories: body.categories || null,
      gpcDetected: body.gpcDetected === true,
      doNotTrack: body.doNotTrack === true,
      pageUrl: cleanPageUrl,
      referrer:
        typeof body.referrer === 'string' ? body.referrer.slice(0, 500) : null,
      userAgent:
        typeof body.userAgent === 'string' ? body.userAgent.slice(0, 512) : null,
      language:
        typeof body.language === 'string' ? body.language.slice(0, 10) : null,
      viewportWidth: Number.isInteger(body.viewportWidth)
        ? body.viewportWidth
        : null,
      viewportHeight: Number.isInteger(body.viewportHeight)
        ? body.viewportHeight
        : null,
    },
  };
}

function hashIp(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const salt = process.env.IP_HASH_SALT;

  if (!salt) {
    throw new Error('IP_HASH_SALT is not configured');
  }

  return crypto
    .createHmac('sha256', salt + today)
    .update(ip || '')
    .digest('hex');
}

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
      countryCode:
        typeof data?.country_code === 'string'
          ? data.country_code.toUpperCase().slice(0, 2)
          : null,
      regionCode:
        typeof data?.region_code === 'string'
          ? data.region_code.toUpperCase().slice(0, 8)
          : null,
    };
  } catch {
    return { countryCode: null, regionCode: null };
  } finally {
    clearTimeout(timeout);
  }
}

export { validatePayload, hashIp, geoLookup };
