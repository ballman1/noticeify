/**
 * Noticeify Scanner — rules/known-vendors.js
 *
 * Fingerprint database for classifying third-party scripts, pixels,
 * and cookies detected during a scan. Each entry maps a URL pattern
 * or cookie name to a vendor classification.
 *
 * Match priority: exact domain > subdomain pattern > path pattern > cookie name
 *
 * risk_level values:
 *   'critical'  — fires before consent and involves advertising/tracking PII
 *   'high'      — likely fires before consent, or contains unclassified marketing tags
 *   'moderate'  — loads before consent but lower privacy impact
 *   'low'       — first-party or strictly necessary
 */

const KNOWN_VENDORS = [

  // ── Analytics ─────────────────────────────────────────────────────────────

  {
    id:           'ga4',
    name:         'Google Analytics 4',
    category:     'analytics',
    domains:      ['www.google-analytics.com', 'analytics.google.com'],
    urlPatterns:  ['/gtag/js', '/analytics.js', '/ga.js'],
    cookieNames:  ['_ga', '_gid', '_gat', '_ga_'],
    riskIfPreConsent: 'high',
    purpose:      'Traffic measurement and user behavior analytics.',
    mayShareData: false,
  },
  {
    id:           'gtm',
    name:         'Google Tag Manager',
    category:     'essential',   // container itself is essential; its tags may not be
    domains:      ['www.googletagmanager.com'],
    urlPatterns:  ['/gtm.js', '/gtag/js'],
    cookieNames:  [],
    riskIfPreConsent: 'high',    // high because it may load marketing tags
    purpose:      'Tag management container.',
    mayShareData: false,
    note:         'GTM itself may be essential, but tags inside it require consent gating.',
  },
  {
    id:           'clarity',
    name:         'Microsoft Clarity',
    category:     'analytics',
    domains:      ['www.clarity.ms'],
    urlPatterns:  ['/tag/'],
    cookieNames:  ['_clck', '_clsk', 'CLID', 'ANONCHK', 'MR', 'MUID', 'SM'],
    riskIfPreConsent: 'high',
    purpose:      'Session recording and heatmaps.',
    mayShareData: false,
  },
  {
    id:           'hotjar',
    name:         'Hotjar',
    category:     'analytics',
    domains:      ['static.hotjar.com', 'script.hotjar.com', 'vars.hotjar.com'],
    urlPatterns:  ['/c/hotjar-'],
    cookieNames:  ['_hjid', '_hjFirstSeen', '_hjSessionUser_', '_hjSession_', '_hjAbsoluteSessionInProgress'],
    riskIfPreConsent: 'high',
    purpose:      'Session recording, heatmaps, and user feedback.',
    mayShareData: false,
  },
  {
    id:           'segment',
    name:         'Segment',
    category:     'analytics',
    domains:      ['cdn.segment.com', 'api.segment.io'],
    urlPatterns:  ['/analytics.js/v1/'],
    cookieNames:  ['ajs_user_id', 'ajs_anonymous_id', 'ajs_group_id'],
    riskIfPreConsent: 'high',
    purpose:      'Customer data platform — routes events to analytics and marketing tools.',
    mayShareData: true,
  },

  // ── Marketing / Advertising ───────────────────────────────────────────────

  {
    id:           'meta-pixel',
    name:         'Meta Pixel',
    category:     'marketing',
    domains:      ['connect.facebook.net', 'www.facebook.com'],
    urlPatterns:  ['/en_US/fbevents.js', '/signals/'],
    cookieNames:  ['_fbp', '_fbc', 'fr', 'datr', 'sb'],
    riskIfPreConsent: 'critical',
    purpose:      'Meta advertising — audience building, retargeting, conversion tracking.',
    mayShareData: true,
  },
  {
    id:           'google-ads',
    name:         'Google Ads / Floodlight',
    category:     'marketing',
    domains:      ['www.googleadservices.com', 'googleads.g.doubleclick.net', 'cm.g.doubleclick.net'],
    urlPatterns:  ['/pagead/', '/conversion/', '/gtag/'],
    cookieNames:  ['_gcl_au', '_gcl_aw', '_gcl_dc', 'IDE', 'DSID', 'FLC'],
    riskIfPreConsent: 'critical',
    purpose:      'Google Ads conversion tracking and audience targeting.',
    mayShareData: true,
  },
  {
    id:           'microsoft-ads',
    name:         'Microsoft Advertising (UET)',
    category:     'marketing',
    domains:      ['bat.bing.com', 'bat.r.msn.com'],
    urlPatterns:  ['/bat.js', '/bat2.js'],
    cookieNames:  ['_uetsid', '_uetvid', 'MUID', 'MR', 'SRM_B'],
    riskIfPreConsent: 'critical',
    purpose:      'Microsoft/Bing Ads conversion tracking and remarketing.',
    mayShareData: true,
  },
  {
    id:           'tiktok-pixel',
    name:         'TikTok Pixel',
    category:     'marketing',
    domains:      ['analytics.tiktok.com', 'business-api.tiktok.com'],
    urlPatterns:  ['/i18n/pixel/events.js'],
    cookieNames:  ['_ttp', '_tt_enable_cookie', 'tt_appInfo', 'ttcsid'],
    riskIfPreConsent: 'critical',
    purpose:      'TikTok Ads conversion tracking and audience retargeting.',
    mayShareData: true,
  },
  {
    id:           'pinterest',
    name:         'Pinterest Tag',
    category:     'marketing',
    domains:      ['s.pinimg.com', 'ct.pinterest.com'],
    urlPatterns:  ['/ct/core.js'],
    cookieNames:  ['_pinterest_ct_ua', '_pinterest_ct_rt', '_pin_unauth'],
    riskIfPreConsent: 'high',
    purpose:      'Pinterest Ads measurement and audience targeting.',
    mayShareData: true,
  },
  {
    id:           'klaviyo',
    name:         'Klaviyo',
    category:     'marketing',
    domains:      ['static.klaviyo.com', 'a.klaviyo.com'],
    urlPatterns:  ['/onsite/js/klaviyo.js'],
    cookieNames:  ['__kla_id', '__klaviyoSessionId'],
    riskIfPreConsent: 'high',
    purpose:      'Email marketing platform with onsite tracking.',
    mayShareData: true,
  },
  {
    id:           'trade-desk',
    name:         'The Trade Desk',
    category:     'marketing',
    domains:      ['js.adsrvr.org', 'insight.adsrvr.org', 'match.adsrvr.org'],
    urlPatterns:  ['/up_loader.1.1.0.js'],
    cookieNames:  ['TDID', 'TDCPM', 'TTDOptOut'],
    riskIfPreConsent: 'critical',
    purpose:      'Programmatic advertising — audience targeting and conversion.',
    mayShareData: true,
  },
  {
    id:           'criteo',
    name:         'Criteo',
    category:     'marketing',
    domains:      ['static.criteo.net', 'dis.criteo.com', 'sslwidget.criteo.com'],
    urlPatterns:  ['/js/ld/ld.js', '/js/ld/publishertag.js'],
    cookieNames:  ['cto_bundle', 'cto_idcpy', 'uid'],
    riskIfPreConsent: 'critical',
    purpose:      'Retargeting and dynamic product advertising.',
    mayShareData: true,
  },
  {
    id:           'snapchat-pixel',
    name:         'Snapchat Pixel',
    category:     'marketing',
    domains:      ['sc-static.net', 'tr.snapchat.com'],
    urlPatterns:  ['/scevent.min.js'],
    cookieNames:  ['_scid', '_sctr', 'sc_at'],
    riskIfPreConsent: 'high',
    purpose:      'Snapchat Ads conversion measurement.',
    mayShareData: true,
  },

  // ── Personalization ────────────────────────────────────────────────────────

  {
    id:           'justuno',
    name:         'Justuno',
    category:     'personalization',
    domains:      ['cdn.justuno.com'],
    urlPatterns:  ['/visitorv2.js'],
    cookieNames:  ['jts_v2', 'jts_session'],
    riskIfPreConsent: 'moderate',
    purpose:      'On-site personalization and exit-intent pop-ups.',
    mayShareData: false,
  },
  {
    id:           'monetate',
    name:         'Monetate / Kibo',
    category:     'personalization',
    domains:      ['se.monetate.net', 'd.monetate.net'],
    urlPatterns:  ['/js/2/'],
    cookieNames:  ['mt.v', 'mt.sr', 'mt.mop'],
    riskIfPreConsent: 'moderate',
    purpose:      'A/B testing and personalization platform.',
    mayShareData: false,
  },
  {
    id:           'optimizely',
    name:         'Optimizely',
    category:     'personalization',
    domains:      ['cdn.optimizely.com'],
    urlPatterns:  ['/js/'],
    cookieNames:  ['optimizelyEndUserId', 'optimizelyBuckets', 'optimizelyRedirectData'],
    riskIfPreConsent: 'moderate',
    purpose:      'A/B testing and experimentation.',
    mayShareData: false,
  },

  // ── Support / Chat ────────────────────────────────────────────────────────

  {
    id:           'zendesk',
    name:         'Zendesk Chat',
    category:     'support',
    domains:      ['static.zdassets.com', 'ekr.zdassets.com'],
    urlPatterns:  ['/ekr/snippet.js'],
    cookieNames:  ['ZD-suid', 'ZD-store', '__zlcmid', 'zdVisitorId'],
    riskIfPreConsent: 'moderate',
    purpose:      'Live chat and customer support widget.',
    mayShareData: false,
  },
  {
    id:           'intercom',
    name:         'Intercom',
    category:     'support',
    domains:      ['widget.intercom.io', 'js.intercomcdn.com'],
    urlPatterns:  ['/widget/'],
    cookieNames:  ['intercom-id-', 'intercom-session-', 'intercom-device-id-'],
    riskIfPreConsent: 'moderate',
    purpose:      'Customer messaging and support platform.',
    mayShareData: false,
  },

  // ── Embedded Media ────────────────────────────────────────────────────────

  {
    id:           'youtube',
    name:         'YouTube',
    category:     'media',
    domains:      ['www.youtube.com', 'www.youtube-nocookie.com', 'youtu.be'],
    urlPatterns:  ['/embed/'],
    cookieNames:  ['YSC', 'VISITOR_INFO1_LIVE', 'PREF', 'GPS', '__Secure-3PAPISID'],
    riskIfPreConsent: 'moderate',
    purpose:      'Embedded video player.',
    mayShareData: true,
    note:         'Use youtube-nocookie.com embeds to reduce cookie exposure.',
  },
  {
    id:           'vimeo',
    name:         'Vimeo',
    category:     'media',
    domains:      ['player.vimeo.com', 'f.vimeocdn.com'],
    urlPatterns:  ['/video/'],
    cookieNames:  ['vuid', '__utmz'],
    riskIfPreConsent: 'moderate',
    purpose:      'Embedded video player.',
    mayShareData: true,
  },

  // ── Healthcare-adjacent (flagged per spec) ────────────────────────────────

  {
    id:           'healthgrades',
    name:         'Healthgrades / Similar Health Network',
    category:     'marketing',
    domains:      ['edge.healthgrades.com'],
    urlPatterns:  [],
    cookieNames:  [],
    riskIfPreConsent: 'critical',
    purpose:      'Health-related advertising network.',
    mayShareData: true,
    sensitiveCategory: true,
  },
];

// ---------------------------------------------------------------------------
// Index structures for fast lookup during scan
// ---------------------------------------------------------------------------

/** Map: hostname → vendor[] */
const DOMAIN_INDEX = new Map();

/** Map: cookie name prefix → vendor[] */
const COOKIE_INDEX = new Map();

for (const vendor of KNOWN_VENDORS) {
  for (const domain of (vendor.domains || [])) {
    const key = domain.toLowerCase();
    if (!DOMAIN_INDEX.has(key)) DOMAIN_INDEX.set(key, []);
    DOMAIN_INDEX.get(key).push(vendor);
  }
  for (const cookie of (vendor.cookieNames || [])) {
    // Cookie names ending in '_' are prefix matches (e.g. '_ga_XXXXXXXX')
    const key = cookie.toLowerCase();
    if (!COOKIE_INDEX.has(key)) COOKIE_INDEX.set(key, []);
    COOKIE_INDEX.get(key).push(vendor);
  }
}

/**
 * Look up a vendor by request hostname.
 * Checks exact match, then strips subdomains iteratively.
 *
 * @param {string} hostname  e.g. 'connect.facebook.net'
 * @returns {object|null}    first matching vendor, or null
 */
function vendorByDomain(hostname) {
  if (!hostname) return null;
  const h = hostname.toLowerCase();

  // Exact match
  if (DOMAIN_INDEX.has(h)) return DOMAIN_INDEX.get(h)[0];

  // Strip subdomains: connect.facebook.net → facebook.net → net
  const parts = h.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (DOMAIN_INDEX.has(parent)) return DOMAIN_INDEX.get(parent)[0];
  }

  return null;
}

/**
 * Look up a vendor by cookie name.
 * Handles both exact matches and prefix matches (e.g. '_ga_').
 *
 * @param {string} cookieName
 * @returns {object|null}
 */
function vendorByCookie(cookieName) {
  if (!cookieName) return null;
  const name = cookieName.toLowerCase();

  // Exact
  if (COOKIE_INDEX.has(name)) return COOKIE_INDEX.get(name)[0];

  // Prefix match (e.g. '_ga_measurement_id')
  for (const [key, vendors] of COOKIE_INDEX) {
    if (key.endsWith('_') && name.startsWith(key)) return vendors[0];
  }

  return null;
}

export { KNOWN_VENDORS, DOMAIN_INDEX, COOKIE_INDEX, vendorByDomain, vendorByCookie };
