/**
 * Noticeify — gpc.js
 *
 * Detects the Global Privacy Control (GPC) signal per the GPC spec:
 * https://globalprivacycontrol.github.io/gpc-spec/
 *
 * GPC can be signaled two ways:
 *   1. navigator.globalPrivacyControl === true  (browser-native, e.g. Firefox + Brave)
 *   2. Sec-GPC: 1 HTTP request header          (server must check this separately)
 *
 * This module handles the JS side (client-side detection). The server-side
 * Sec-GPC header check should be handled in your backend middleware.
 *
 * When GPC is detected, Noticeify treats marketing and personalization
 * categories as denied by default. The user can still open preferences and
 * override, but the system defaults to the conservative interpretation.
 */

/**
 * Returns true if a GPC signal is present in this browser session.
 * @returns {boolean}
 */
function isGPCEnabled() {
  // navigator.globalPrivacyControl is the spec-defined property
  if (typeof navigator !== 'undefined' && navigator.globalPrivacyControl === true) {
    return true;
  }
  return false;
}

/**
 * Returns the default category grants to apply when GPC is active.
 * Marketing and personalization are forced to false; others remain
 * at their default off state (user still gets the banner to opt in
 * to functional/analytics/etc).
 *
 * @returns {object} partial categories override
 */
function getGPCDefaults() {
  return {
    marketing:       false,
    personalization: false,
  };
}

export { isGPCEnabled, getGPCDefaults };
