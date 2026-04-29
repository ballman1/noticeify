/**
 * ConsentGuard — gtm-consent-config.js
 *
 * This file is NOT injected into the page. It is a reference document
 * for configuring Google Tag Manager so that all tags inside GTM respect
 * Consent Mode v2 signals and never fire before consent.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * REQUIRED GTM SETUP
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. CONSENT INITIALIZATION TAG
 * ─────────────────────────────
 * In GTM, create a Custom HTML tag that fires on "Consent Initialization -
 * All Pages" (this trigger fires before all other tags).
 *
 * The tag should contain ONLY this:
 *
 *   <script>
 *     window.dataLayer = window.dataLayer || [];
 *     function gtag(){dataLayer.push(arguments);}
 *     gtag('consent', 'default', {
 *       'ad_storage': 'denied',
 *       'ad_user_data': 'denied',
 *       'ad_personalization': 'denied',
 *       'analytics_storage': 'denied',
 *       'functionality_storage': 'denied',
 *       'personalization_storage': 'denied',
 *       'security_storage': 'granted',
 *       'wait_for_update': 500
 *     });
 *     gtag('set', 'url_passthrough', true);
 *     gtag('set', 'ads_data_redaction', true);
 *   </script>
 *
 * NOTE: ConsentGuard's consent-loader.js also sets these defaults via the
 * gtag shim. The GTM tag is a belt-and-suspenders fallback for environments
 * where the ConsentGuard script somehow loads after GTM (should not happen
 * if the embed tag is placed first in <head>, but this protects you).
 *
 *
 * 2. CONSENT STATE VARIABLE
 * ──────────────────────────
 * In GTM > Variables, create a JavaScript Variable for each signal you
 * want to read in triggers:
 *
 *   Variable name: CG - Analytics Consent
 *   Variable type: JavaScript Variable
 *   Global Variable Name: ConsentManager
 *   (then use a Custom JS Variable instead — see below)
 *
 * Create a Custom JavaScript Variable called "CG - Has Analytics Consent":
 *
 *   function() {
 *     return window.ConsentManager && window.ConsentManager.hasConsent('analytics');
 *   }
 *
 * Create similar variables for each category:
 *   CG - Has Marketing Consent     → hasConsent('marketing')
 *   CG - Has Functional Consent    → hasConsent('functional')
 *   CG - Has Support Consent       → hasConsent('support')
 *   CG - Has Personalization Consent → hasConsent('personalization')
 *   CG - Has Media Consent         → hasConsent('media')
 *
 *
 * 3. CONSENT-BASED TRIGGERS
 * ──────────────────────────
 * For tags that should fire ONLY after a consent update (e.g. Meta Pixel
 * base code via GTM instead of vendor-registry.js), use:
 *
 *   Trigger type: Custom Event
 *   Event name:   cg_consent_update
 *   Condition:    CG - Has Marketing Consent equals true
 *
 * ConsentGuard fires a 'cg_consent_update' dataLayer event after every
 * consent change (see the pushConsentEvent() call in consent-loader.js).
 * This lets GTM-managed tags also react to consent changes.
 *
 *
 * 4. BUILT-IN CONSENT CHECKS ON GOOGLE TAGS
 * ───────────────────────────────────────────
 * For Google tags (GA4, Google Ads), use the built-in consent settings:
 *
 *   In each Google tag's Advanced Settings > Consent Settings:
 *   - Require consent: ad_storage (for Google Ads tags)
 *   - Require consent: analytics_storage (for GA4 tags)
 *
 * This means even if a tag trigger fires, Google's own Consent Mode check
 * will suppress the cookie/measurement behavior if the signal is denied.
 * Consent Mode v2 gives you two layers of protection:
 *   Layer 1: ConsentGuard prevents the tag from loading at all
 *   Layer 2: Google's Consent Mode prevents the tag from measuring if it
 *            somehow gets past layer 1 (defense in depth)
 *
 *
 * 5. CUSTOM HTML TAGS IN GTM — THE RISK
 * ───────────────────────────────────────
 * Custom HTML tags in GTM are the most common source of pre-consent
 * pixel fires because they bypass Consent Mode. Every Custom HTML tag
 * in your container should have:
 *
 *   a) A trigger condition: CG - Has [Category] Consent equals true
 *   b) OR be moved entirely out of GTM and into the vendor-registry.js
 *
 * For Klaviyo specifically: move the onsite JS tag from GTM Custom HTML
 * into vendor-registry.js (it's already there). Remove the GTM tag.
 *
 *
 * 6. DATALAYER EVENTS FIRED BY CONSENTGUARD
 * ───────────────────────────────────────────
 * ConsentGuard pushes these events to dataLayer so GTM can react:
 *
 *   cg_consent_update — fires after any consent change
 *     payload: { consentCategories: { analytics, marketing, ... } }
 *
 *   cg_consent_loaded — fires on page load when stored consent is found
 *     payload: { consentCategories: { ... } }
 *
 *   cg_banner_shown   — fires when the banner is displayed
 *
 *   cg_gpc_detected   — fires when a GPC signal is found
 *
 * You can use these as GTM trigger events.
 */

/**
 * GTM dataLayer event helper — called by consent-loader.js
 * after every consent change.
 *
 * @param {string} eventName
 * @param {object} payload
 */
function pushConsentEvent(eventName, payload = {}) {
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({
    event: eventName,
    ...payload,
  });
}

/**
 * Builds the consentCategories payload for dataLayer pushes.
 * GTM triggers can use these as conditions.
 *
 * @param {object} categories
 * @returns {object}
 */
function buildDataLayerPayload(categories) {
  return {
    consentCategories: {
      functional:      !!categories?.functional,
      analytics:       !!categories?.analytics,
      marketing:       !!categories?.marketing,
      personalization: !!categories?.personalization,
      support:         !!categories?.support,
      media:           !!categories?.media,
    },
  };
}

export { pushConsentEvent, buildDataLayerPayload };
