/**
 * Noticeify — consent-loader.js
 *
 * The consent loader is the central engine. It runs as early as possible in
 * the page lifecycle and orchestrates everything:
 *
 *   1. Initialize Google Consent Mode v2 defaults (all denied)
 *   2. Check for GPC signal
 *   3. Load stored consent from cookie/localStorage
 *   4. Decide whether to show the banner or apply stored consent
 *   5. Load vendors whose categories have been approved
 *   6. Expose the public ConsentManager API on window
 *
 * Execution order guarantee:
 *   setConsentModeDefaults() → (GPC check) → (load stored consent OR show banner)
 *   → loadApprovedVendors() → updateConsentMode()
 *
 * The banner and preference center UI are in consent-ui.js and are only
 * imported lazily when needed, keeping this file as lean as possible.
 */

import { setConsentModeDefaults, updateConsentMode } from './consent-mode.js';
import { saveConsent, loadConsent, clearConsent }    from './consent-storage.js';
import { isGPCEnabled, getGPCDefaults }              from './gpc.js';
import { VENDOR_REGISTRY }                           from '../registry/vendor-registry.js';
import {
  logConsentEvent,
  logWithdrawal,
  registerPagehideHandler,
} from './consent-logger.js';
import { pushConsentEvent, buildDataLayerPayload } from '../gtm/gtm-consent-config.js';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _currentConsent    = null;   // the active consent record (or null = undecided)
let _gpcDetected       = false;
let _loadedVendorIds   = new Set();
let _changeCallbacks   = [];     // registered via onConsentChange()
let _clientId          = '';

// ---------------------------------------------------------------------------
// Bootstrap — call this once, as early as possible in <head>
// ---------------------------------------------------------------------------

/**
 * Primary entry point. Called automatically when consent.js is loaded via
 * the <script> embed tag.
 *
 * @param {object} config
 * @param {string} config.clientId   — Noticeify client identifier
 * @param {string} config.domain     — the website domain (for logging)
 */
async function init(config = {}) {
  _clientId = config.clientId || '';

  // ── Step 1: Set Consent Mode defaults immediately (before any Google tag) ──
  setConsentModeDefaults();

  // ── Step 2: Load essential vendors (GTM, payment scripts, etc.) ────────────
  // Essential vendors load unconditionally — but AFTER Consent Mode defaults
  // are set, so GTM respects the denied state for its contained tags.
  loadEssentialVendors();

  // ── Step 3: Check GPC ──────────────────────────────────────────────────────
  _gpcDetected = isGPCEnabled();
  if (_gpcDetected) {
    pushConsentEvent('nfy_gpc_detected', {});
  }

  // ── Step 4: Check for existing stored consent ──────────────────────────────
  const stored = loadConsent();

  if (stored) {
    // User has consented before and the consent version still matches.
    // Apply immediately — no banner needed.
    _currentConsent = stored;

    // If GPC is now active but stored consent had marketing=true, we need to
    // re-evaluate. Conservative choice: honor GPC and suppress marketing.
    if (_gpcDetected) {
      const gpcOverrides = getGPCDefaults();
      _currentConsent = {
        ..._currentConsent,
        categories: { ..._currentConsent.categories, ...gpcOverrides },
      };
    }

    applyConsent(_currentConsent.categories, false);

  } else {
    // No valid stored consent — show the banner.
    // Lazy-load the UI module so it doesn't add weight to every page load
    // for returning users who have already consented.
    const { showBanner } = await import('./consent-ui.js');
    showBanner({
      gpcDetected: _gpcDetected,
      onAcceptAll:          handleAcceptAll,
      onRejectNonEssential: handleRejectNonEssential,
      onSavePreferences:    handleSavePreferences,
    });
  }
}

// ---------------------------------------------------------------------------
// Consent handlers — called by the UI buttons
// ---------------------------------------------------------------------------

function handleAcceptAll() {
  const categories = {
    functional:      true,
    analytics:       true,
    marketing:       _gpcDetected ? false : true, // GPC overrides accept-all
    personalization: _gpcDetected ? false : true,
    support:         true,
    media:           true,
  };
  commitConsent(categories, 'banner');
}

function handleRejectNonEssential() {
  const categories = {
    functional:      false,
    analytics:       false,
    marketing:       false,
    personalization: false,
    support:         false,
    media:           false,
  };
  commitConsent(categories, 'banner');
}

/**
 * Called when the user saves custom preferences from the preference center.
 * @param {object} categories — the user's category selections
 */
function handleSavePreferences(categories) {
  // If GPC is active, marketing/personalization cannot be re-enabled
  // through the preference center without a deliberate user action.
  // (Per the spec, we preserve a conservative interpretation of GPC
  //  unless the client's legal config explicitly allows override.)
  const resolved = { ...categories };
  if (_gpcDetected) {
    const gpcDefaults = getGPCDefaults();
    Object.assign(resolved, gpcDefaults);
  }
  commitConsent(resolved, 'preference_center');
}

// ---------------------------------------------------------------------------
// Core consent application
// ---------------------------------------------------------------------------

/**
 * Persist, apply, and broadcast a consent decision.
 * @param {object} categories
 * @param {string} source
 */
function commitConsent(categories, source) {
  // Save to cookie/localStorage
  const record = saveConsent(categories, source, {
    clientId:    _clientId,
    gpcDetected: _gpcDetected,
  });
  _currentConsent = record;

  applyConsent(categories, true);
}

/**
 * Apply a consent decision: update Consent Mode, load approved vendors,
 * fire change callbacks, and push dataLayer event for GTM.
 *
 * @param {object}  categories
 * @param {boolean} broadcast — whether to fire onConsentChange callbacks
 */
function applyConsent(categories, broadcast) {
  // Update Google Consent Mode signals
  updateConsentMode(categories);

  // Load any vendors whose category is now approved and hasn't loaded yet
  loadApprovedVendors(categories);

  if (broadcast) {
    // Log to Noticeify API
    if (_currentConsent) logConsentEvent(_currentConsent);

    // Push to GTM dataLayer so GTM-managed tags can react
    pushConsentEvent('nfy_consent_update', buildDataLayerPayload(categories));

    // Fire registered callbacks
    _changeCallbacks.forEach(cb => {
      try { cb({ categories, consent: _currentConsent }); } catch (_) {}
    });
  } else {
    // Stored consent loaded on page load — fire a distinct dataLayer event
    pushConsentEvent('nfy_consent_loaded', buildDataLayerPayload(categories));
  }
}

// ---------------------------------------------------------------------------
// Vendor loading
// ---------------------------------------------------------------------------

/**
 * Loads essential vendors unconditionally.
 * GTM must load AFTER Consent Mode defaults are set.
 */
function loadEssentialVendors() {
  VENDOR_REGISTRY
    .filter(v => v.category === 'essential' && v.load)
    .forEach(vendor => {
      if (!_loadedVendorIds.has(vendor.id)) {
        try {
          vendor.load();
          _loadedVendorIds.add(vendor.id);
        } catch (e) {
          console.warn('[Noticeify] Failed to load essential vendor:', vendor.id, e);
        }
      }
    });
}

/**
 * Iterate the vendor registry and call load() for every vendor whose
 * category has been approved and hasn't already been loaded.
 *
 * @param {object} categories
 */
function loadApprovedVendors(categories) {
  VENDOR_REGISTRY.forEach(vendor => {
    if (vendor.category === 'essential') return; // already handled
    if (_loadedVendorIds.has(vendor.id)) return;  // don't double-load
    if (!vendor.load) return;                     // documented-only vendor

    if (categories[vendor.category] === true) {
      try {
        vendor.load();
        _loadedVendorIds.add(vendor.id);
      } catch (e) {
        console.warn('[Noticeify] Failed to load vendor:', vendor.id, e);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Public API — window.Noticeify
// ---------------------------------------------------------------------------

/**
 * Returns a copy of the current consent record, or null if no decision
 * has been made yet.
 */
function getConsent() {
  return _currentConsent ? { ..._currentConsent } : null;
}

/**
 * Returns true if the given category has been granted.
 * Also returns true for 'essential' (always granted).
 *
 * @param {string} category
 * @returns {boolean}
 */
function hasConsent(category) {
  if (category === 'essential') return true;
  if (!_currentConsent) return false;
  return _currentConsent.categories[category] === true;
}

/**
 * Programmatically update consent (e.g. from a server-side consent record
 * or a headless integration). Persists and broadcasts the change.
 *
 * @param {object} categories
 */
function updateConsent(categories) {
  commitConsent(categories, 'api');
}

/**
 * Withdraw all non-essential consent and clear stored records.
 */
function withdrawConsent() {
  clearConsent();
  logWithdrawal(_clientId, _gpcDetected);

  _currentConsent = null;
  _loadedVendorIds.clear();

  // Update Consent Mode to denied
  updateConsentMode({
    functional: false, analytics: false, marketing: false,
    personalization: false, support: false, media: false,
  });

  // Broadcast withdrawal
  _changeCallbacks.forEach(cb => {
    try { cb({ categories: null, consent: null }); } catch (_) {}
  });
}

/**
 * Open the preference center panel.
 * Lazily loads consent-ui.js and calls its openPreferenceCenter function.
 */
async function openPreferences() {
  const { openPreferenceCenter } = await import('./consent-ui.js');
  openPreferenceCenter({
    currentCategories: _currentConsent ? _currentConsent.categories : {},
    gpcDetected:       _gpcDetected,
    onSave:            handleSavePreferences,
  });
}

/**
 * Register a callback that fires whenever consent changes.
 * Callback receives: { categories, consent }
 *
 * @param {function} callback
 */
function onConsentChange(callback) {
  if (typeof callback === 'function') {
    _changeCallbacks.push(callback);
  }
}

// ---------------------------------------------------------------------------
// Expose public API on window
// ---------------------------------------------------------------------------

window.Noticeify = {
  getConsent,
  hasConsent,
  updateConsent,
  withdrawConsent,
  openPreferences,
  onConsentChange,
};

// ---------------------------------------------------------------------------
// Auto-init from script tag data attributes
// ---------------------------------------------------------------------------

(function autoInit() {
  const script = document.currentScript ||
    document.querySelector('script[data-client-id]');

  if (!script) {
    console.warn('[Noticeify] Could not find embed script tag. Call Noticeify.init() manually.');
    return;
  }

  const clientId = script.getAttribute('data-client-id') || '';
  const domain   = script.getAttribute('data-domain')    || location.hostname;

  init({ clientId, domain });

  // Pagehide handler — ensures records are flushed if user navigates immediately
  // after making a consent choice. Defined here so it has closure over _currentConsent.
  registerPagehideHandler(() => _currentConsent);
})();
