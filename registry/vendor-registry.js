/**
 * Noticeify — vendor-registry.js
 *
 * The vendor registry is the single source of truth for every third-party
 * script on the site. NO third-party script should be hardcoded into the
 * page template. Instead, add it here and the consent loader will only
 * inject it after the user has granted the matching category.
 *
 * Each vendor entry shape:
 * {
 *   id:          string    — unique key, used for logging
 *   name:        string    — human-readable name (shown in dashboard)
 *   category:    string    — must match a Noticeify category key
 *   src:         string?   — script URL to inject (if script tag needed)
 *   async:       boolean?  — whether to set async on the injected script
 *   load:        function? — custom loader fn (for vendors needing inline init)
 *   cookies:     string[]  — cookie names this vendor may set (for audit)
 *   purpose:     string    — one-sentence plain-English purpose statement
 *   mayShareData: boolean  — whether this vendor may involve sale/share of data
 *   owner:       string    — internal team or person responsible for this tag
 *   lastReviewed: string   — YYYY-MM-DD
 * }
 *
 * Categories:
 *   'essential'       — always loads, no consent needed
 *   'functional'      — functional/UX enhancements
 *   'analytics'       — traffic and behavior analysis
 *   'marketing'       — advertising, retargeting, remarketing
 *   'personalization' — content and product personalization
 *   'support'         — live chat and customer support
 *   'media'           — embedded video and third-party media
 */

// ---------------------------------------------------------------------------
// Replace these placeholder IDs with your real account IDs before deploying
// ---------------------------------------------------------------------------
const IDS = {
  GA4_MEASUREMENT_ID:  'G-XXXXXXXXXX',
  GTM_CONTAINER_ID:    'GTM-XXXXXXX',
  META_PIXEL_ID:       '000000000000000',
  MICROSOFT_UET_TAG:   'xxxxxxxxx',
  TIKTOK_PIXEL_ID:     'XXXXXXXXXXXXXXXXXX',
  PINTEREST_TAG_ID:    'xxxxxxxxxxxxxxxxxx',
  KLAVIYO_COMPANY_ID:  'XXXXXX',
  ZENDESK_KEY:         'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  CLARITY_PROJECT_ID:  'xxxxxxxxxx',
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const VENDOR_REGISTRY = [

  // ── STRICTLY NECESSARY (no consent gate — loads immediately) ─────────────

  {
    id:           'gtm',
    name:         'Google Tag Manager',
    category:     'essential',
    // GTM itself is essential but its TAGS are not. Noticeify loads GTM
    // after setting Consent Mode defaults so all tags inside GTM respect
    // the consent signals. Tags inside GTM should be configured with
    // consent checks (see gtm-consent-config.js for required GTM setup).
    load() {
      const s = document.createElement('script');
      s.async = true;
      s.src = `https://www.googletagmanager.com/gtm.js?id=${IDS.GTM_CONTAINER_ID}`;
      document.head.appendChild(s);

      // Also push the dataLayer init snippet
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });

      // GTM noscript fallback — append to body when DOM is ready
      document.addEventListener('DOMContentLoaded', () => {
        const ns = document.createElement('noscript');
        const iframe = document.createElement('iframe');
        iframe.src = `https://www.googletagmanager.com/ns.html?id=${IDS.GTM_CONTAINER_ID}`;
        iframe.height = '0';
        iframe.width = '0';
        iframe.style.cssText = 'display:none;visibility:hidden';
        ns.appendChild(iframe);
        document.body.insertBefore(ns, document.body.firstChild);
      });
    },
    cookies:     ['_ga', '_gid', '_gat'],
    purpose:     'Tag management container — required to fire any measurement or ad tags.',
    mayShareData: false,
    owner:       'digital-marketing',
    lastReviewed: '2026-04-01',
  },

  // ── ANALYTICS ────────────────────────────────────────────────────────────

  {
    id:       'ga4',
    name:     'Google Analytics 4',
    category: 'analytics',
    // GA4 is loaded via GTM using Consent Mode. When analytics_storage is
    // granted, GTM fires the GA4 tag. When denied, GTM fires in cookieless
    // modeling mode. This entry exists to document the vendor and give
    // Noticeify a hook to update Consent Mode signals correctly.
    // The actual script injection is handled by GTM — no src needed here.
    load: null,
    cookies:     ['_ga', '_ga_XXXXXXXXXX'],
    purpose:     'Measures site traffic, user behavior, and e-commerce performance.',
    mayShareData: false,
    owner:       'analytics',
    lastReviewed: '2026-04-01',
  },

  {
    id:       'clarity',
    name:     'Microsoft Clarity',
    category: 'analytics',
    load() {
      // Clarity's recommended inline init snippet
      window.clarity = window.clarity || function () {
        (window.clarity.q = window.clarity.q || []).push(arguments);
      };
      const s = document.createElement('script');
      s.async = true;
      s.src = `https://www.clarity.ms/tag/${IDS.CLARITY_PROJECT_ID}`;
      document.head.appendChild(s);
    },
    cookies:     ['_clck', '_clsk', 'CLID', 'ANONCHK', 'MR', 'MUID', 'SM'],
    purpose:     'Session recording and heatmap analysis to improve site usability.',
    mayShareData: false,
    owner:       'analytics',
    lastReviewed: '2026-04-01',
  },

  // ── MARKETING / ADVERTISING ───────────────────────────────────────────────

  {
    id:       'meta-pixel',
    name:     'Meta Pixel',
    category: 'marketing',
    load() {
      // Standard Meta Pixel base code
      !function(f,b,e,v,n,t,s) {
        if(f.fbq) return;
        n=f.fbq=function(){n.callMethod ?
          n.callMethod.apply(n,arguments) : n.queue.push(arguments)};
        if(!f._fbq) f._fbq=n;
        n.push=n; n.loaded=!0; n.version='2.0';
        n.queue=[];
        t=b.createElement(e); t.async=!0;
        t.src=v;
        s=b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t,s);
      }(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');

      window.fbq('init', IDS.META_PIXEL_ID);
      window.fbq('track', 'PageView');
    },
    cookies:     ['_fbp', '_fbc', 'fr'],
    purpose:     'Measures Meta ad performance and enables retargeting audiences.',
    mayShareData: true,
    owner:       'digital-marketing',
    lastReviewed: '2026-04-01',
  },

  {
    id:       'microsoft-ads',
    name:     'Microsoft Advertising (UET)',
    category: 'marketing',
    load() {
      window.uetq = window.uetq || [];
      const s = document.createElement('script');
      s.async = true;
      s.src = 'https://bat.bing.com/bat.js';
      s.onload = function () {
        window.uetq = new UET({ // eslint-disable-line no-undef
          ti: IDS.MICROSOFT_UET_TAG,
          enableAutoSpaTracking: true,
        });
        window.uetq.push('pageLoad');
      };
      document.head.appendChild(s);
    },
    cookies:     ['_uetsid', '_uetvid', 'MUID'],
    purpose:     'Measures Microsoft/Bing Ads performance and enables remarketing.',
    mayShareData: true,
    owner:       'digital-marketing',
    lastReviewed: '2026-04-01',
  },

  {
    id:       'tiktok-pixel',
    name:     'TikTok Pixel',
    category: 'marketing',
    load() {
      !function(w,d,t) {
        w.TiktokAnalyticsObject=t;
        var ttq=w[t]=w[t]||[];
        ttq.methods=['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie'];
        ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};
        for(var i=0;i<ttq.methods.length;i++) ttq.setAndDefer(ttq,ttq.methods[i]);
        ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e};
        ttq.load=function(e,n){var i='https://analytics.tiktok.com/i18n/pixel/events.js';ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=i;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};var o=document.createElement('script');o.type='text/javascript';o.async=!0;o.src=i+'?sdkid='+e+'&lib='+t;var a=document.getElementsByTagName('script')[0];a.parentNode.insertBefore(o,a)};
        ttq.load(IDS.TIKTOK_PIXEL_ID);
        ttq.page();
      }(window,document,'ttq');
    },
    cookies:     ['_ttp', '_tt_enable_cookie', '_tt_disable_cookie'],
    purpose:     'Measures TikTok ad performance and enables retargeting audiences.',
    mayShareData: true,
    owner:       'digital-marketing',
    lastReviewed: '2026-04-01',
  },

  {
    id:       'klaviyo',
    name:     'Klaviyo',
    category: 'marketing',
    load() {
      // Klaviyo onsite JS — only loads the identify/track capability,
      // NOT the email signup forms (those are loaded separately as needed)
      const s = document.createElement('script');
      s.async = true;
      s.type = 'text/javascript';
      s.src = `https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=${IDS.KLAVIYO_COMPANY_ID}`;
      document.head.appendChild(s);
    },
    cookies:     ['__kla_id', '__klaviyoSessionId'],
    purpose:     'Email marketing platform — tracks site behavior to personalize email campaigns.',
    mayShareData: true,
    owner:       'email-marketing',
    lastReviewed: '2026-04-01',
  },

  {
    id:       'pinterest',
    name:     'Pinterest Tag',
    category: 'marketing',
    load() {
      !function(e){
        if(!window.pintrk){
          window.pintrk = function () {
            window.pintrk.queue.push(Array.prototype.slice.call(arguments));
          };
          var n=window.pintrk;
          n.queue=[]; n.version='3.0';
          var t=document.createElement('script');
          t.async=!0; t.src=e;
          var r=document.getElementsByTagName('script')[0];
          r.parentNode.insertBefore(t,r);
        }
      }('https://s.pinimg.com/ct/core.js');
      window.pintrk('load', IDS.PINTEREST_TAG_ID);
      window.pintrk('page');
    },
    cookies:     ['_pinterest_ct_ua', '_pinterest_ct_rt', '_pin_unauth'],
    purpose:     'Measures Pinterest ad performance and enables audience retargeting.',
    mayShareData: true,
    owner:       'digital-marketing',
    lastReviewed: '2026-04-01',
  },

  // ── PERSONALIZATION ───────────────────────────────────────────────────────

  {
    id:       'justuno',
    name:     'Justuno',
    category: 'personalization',
    load() {
      window._jts = window._jts || [];
      const s = document.createElement('script');
      s.async = true;
      s.src = 'https://cdn.justuno.com/visitorv2.js';
      document.head.appendChild(s);
    },
    cookies:     ['jts_*'],
    purpose:     'On-site personalization, pop-up promotions, and exit-intent offers.',
    mayShareData: false,
    owner:       'digital-marketing',
    lastReviewed: '2026-04-01',
  },

  // ── SUPPORT / CHAT ────────────────────────────────────────────────────────

  {
    id:       'zendesk',
    name:     'Zendesk Chat',
    category: 'support',
    load() {
      window.zESettings = window.zESettings || {};
      const s = document.createElement('script');
      s.id = 'ze-snippet';
      s.async = true;
      s.src = `https://static.zdassets.com/ekr/snippet.js?key=${IDS.ZENDESK_KEY}`;
      document.body.appendChild(s);
    },
    cookies:     ['ZD-suid', 'ZD-store', '__zlcmid'],
    purpose:     'Provides live chat and customer support widget.',
    mayShareData: false,
    owner:       'customer-service',
    lastReviewed: '2026-04-01',
  },

  // ── EMBEDDED MEDIA ────────────────────────────────────────────────────────

  // YouTube and Vimeo embeds are handled by the media-embed-gate.js utility
  // rather than script injection. See that module for iframe replacement logic.

];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Get all vendors in a specific category.
 * @param {string} category
 * @returns {object[]}
 */
function getVendorsByCategory(category) {
  return VENDOR_REGISTRY.filter(v => v.category === category);
}

/**
 * Get a single vendor by ID.
 * @param {string} id
 * @returns {object|undefined}
 */
function getVendorById(id) {
  return VENDOR_REGISTRY.find(v => v.id === id);
}

export { VENDOR_REGISTRY, IDS, getVendorsByCategory, getVendorById };
