/**
 * Noticeify — consent-storage.js
 *
 * Handles reading, writing, and versioning of consent records in the browser.
 * All consent state lives in a single JSON cookie so it survives page loads
 * and can be inspected by the server if needed. A copy is also kept in
 * localStorage as a fallback for SPA environments that clear cookies on
 * certain routes.
 *
 * Cookie name:  nfy_consent
 * localStorage: nfy_consent
 */

const COOKIE_NAME   = 'nfy_consent';
const STORAGE_KEY   = 'nfy_consent';
const CONSENT_VERSION = '1.0'; // bump when banner copy or category set changes

/**
 * The shape of a stored consent record.
 *
 * {
 *   version:    string        — consent schema version (bump = re-prompt)
 *   clientId:   string        — which Noticeify client this belongs to
 *   consentId:  string        — UUID for this specific consent event
 *   timestamp:  string        — ISO 8601
 *   source:     string        — 'banner' | 'preference_center' | 'gpc' | 'api'
 *   gpcDetected: boolean
 *   categories: {
 *     functional:      boolean
 *     analytics:       boolean
 *     marketing:       boolean
 *     personalization: boolean
 *     support:         boolean
 *     media:           boolean
 *   }
 * }
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateConsentId() {
  // Generates a short UUID-like ID without crypto dependency
  return 'nfy_' + Date.now().toString(36) + '_' +
    Math.random().toString(36).slice(2, 8);
}

function cookieExpiry(days) {
  const d = new Date();
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  return d.toUTCString();
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Persist a consent record to cookie + localStorage.
 * Returns the full record that was written (including generated consentId).
 *
 * @param {object} categories  — map of category name → boolean
 * @param {string} source      — where the consent came from
 * @param {object} meta        — { clientId, gpcDetected }
 * @returns {object}           — the saved consent record
 */
function saveConsent(categories, source, meta) {
  const record = {
    version:     CONSENT_VERSION,
    clientId:    meta.clientId || '',
    consentId:   generateConsentId(),
    timestamp:   new Date().toISOString(),
    source:      source || 'unknown',
    gpcDetected: meta.gpcDetected === true,
    categories: {
      functional:      !!categories.functional,
      analytics:       !!categories.analytics,
      marketing:       !!categories.marketing,
      personalization: !!categories.personalization,
      support:         !!categories.support,
      media:           !!categories.media,
    },
  };

  const json = JSON.stringify(record);

  // Cookie — 365 day expiry, SameSite=Lax, no HttpOnly (must be JS-readable)
  // If running on HTTPS (production), add Secure flag
  const secureFlag = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = COOKIE_NAME + '=' + encodeURIComponent(json) +
    '; expires=' + cookieExpiry(365) +
    '; path=/' +
    '; SameSite=Lax' +
    secureFlag;

  // localStorage fallback
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch (_) {
    // localStorage blocked (private mode, storage full) — cookie is the source of truth
  }

  return record;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Load the stored consent record. Returns null if no consent has been given
 * or if the stored version is outdated (triggers re-prompt).
 *
 * @returns {object|null}
 */
function loadConsent() {
  let json = null;

  // Try cookie first
  const match = document.cookie.match(
    new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]+)')
  );
  if (match) {
    try { json = decodeURIComponent(match[1]); } catch (_) {}
  }

  // Fallback to localStorage
  if (!json) {
    try { json = localStorage.getItem(STORAGE_KEY); } catch (_) {}
  }

  if (!json) return null;

  let record;
  try { record = JSON.parse(json); } catch (_) { return null; }

  // Version check — if banner/categories changed, treat as no consent
  if (!record || record.version !== CONSENT_VERSION) {
    clearConsent();
    return null;
  }

  return record;
}

// ---------------------------------------------------------------------------
// Clear / withdraw
// ---------------------------------------------------------------------------

function clearConsent() {
  // Expire the cookie immediately
  document.cookie = COOKIE_NAME + '=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/';
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  CONSENT_VERSION,
  saveConsent,
  loadConsent,
  clearConsent,
};
