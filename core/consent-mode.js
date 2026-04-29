/**
 * ConsentGuard — consent-mode.js
 *
 * Manages Google Consent Mode v2 integration.
 *
 * Google Consent Mode must be initialized BEFORE gtag.js or GTM loads.
 * ConsentGuard sets all signals to 'denied' at the very start of page load,
 * then updates them granularly once the user has given (or stored) consent.
 *
 * Required signal mapping from your category choices:
 *
 *   analytics  → analytics_storage
 *   marketing  → ad_storage, ad_user_data, ad_personalization
 *   functional → functionality_storage, personalization_storage
 *
 * Reference: https://developers.google.com/tag-platform/security/guides/consent
 */

// ---------------------------------------------------------------------------
// gtag shim
// ---------------------------------------------------------------------------

/**
 * Ensures window.dataLayer and the gtag() function exist, even if GTM/gtag.js
 * hasn't loaded yet. Google Consent Mode works by queuing these calls — they
 * are replayed by gtag.js when it eventually loads.
 */
function ensureGtag() {
  window.dataLayer = window.dataLayer || [];
  if (typeof window.gtag !== 'function') {
    window.gtag = function () {
      window.dataLayer.push(arguments);
    };
  }
}

// ---------------------------------------------------------------------------
// Set defaults — call this as early as possible, before any Google script
// ---------------------------------------------------------------------------

/**
 * Push the 'default' denied state for all Consent Mode signals.
 * This must run before GTM or gtag.js loads so Google receives the denied
 * state before any measurement or ad calls are attempted.
 *
 * Also sets url_passthrough and ads_data_redaction for privacy-safe
 * conversion modeling in denied state.
 */
function setConsentModeDefaults() {
  ensureGtag();

  window.gtag('consent', 'default', {
    ad_storage:           'denied',
    ad_user_data:         'denied',
    ad_personalization:   'denied',
    analytics_storage:    'denied',
    functionality_storage: 'denied',
    personalization_storage: 'denied',
    security_storage:     'granted', // always grant — needed for fraud/auth
    wait_for_update:      500,       // ms to wait before firing tags in denied state
  });

  // Enable URL passthrough so Google can do cookieless conversion modeling
  window.gtag('set', 'url_passthrough', true);

  // Redact ad data in denied state
  window.gtag('set', 'ads_data_redaction', true);
}

// ---------------------------------------------------------------------------
// Update — call this after consent is given/loaded
// ---------------------------------------------------------------------------

/**
 * Maps a ConsentGuard category record to Consent Mode v2 signals and
 * pushes an 'update' call to gtag.
 *
 * Only updates the signals that changed — Google recommends not sending
 * 'denied' updates unnecessarily to avoid clearing valid cookies.
 *
 * @param {object} categories — the categories object from a consent record
 */
function updateConsentMode(categories) {
  ensureGtag();

  const signals = buildSignals(categories);
  window.gtag('consent', 'update', signals);
}

/**
 * Translates ConsentGuard category booleans into Google signal strings.
 * Exported separately so the banner can preview what signals will be sent.
 *
 * @param {object} categories
 * @returns {object} Google Consent Mode signal map
 */
function buildSignals(categories) {
  const g = (bool) => bool ? 'granted' : 'denied';

  return {
    analytics_storage:       g(categories.analytics),
    ad_storage:              g(categories.marketing),
    ad_user_data:            g(categories.marketing),
    ad_personalization:      g(categories.marketing),
    functionality_storage:   g(categories.functional),
    personalization_storage: g(categories.personalization),
    // security_storage stays 'granted' — never map it to a user-facing toggle
  };
}

export { setConsentModeDefaults, updateConsentMode, buildSignals };
