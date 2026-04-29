/**
 * ConsentGuard Scanner — core/page-scanner.js
 *
 * Scans a single URL using Playwright (Chromium) to detect:
 *   - Third-party scripts loading before consent
 *   - Cookies set before consent
 *   - Tracking pixels firing before consent
 *   - Known advertising/analytics domains
 *   - Unregistered/unclassified scripts
 *   - iframe embeds that may set cookies
 *   - localStorage and sessionStorage usage
 *
 * The scanner runs in three phases per URL:
 *
 *   Phase 1 — PRE-CONSENT
 *     Load the page with no cookies and no consent state.
 *     Record all network requests, cookies set, and JS storage usage.
 *     This reveals what fires without user consent.
 *
 *   Phase 2 — POST-CONSENT (accept all)
 *     Re-load the page after injecting a simulated "accept all" consent cookie.
 *     Record what additional scripts/requests fire.
 *     This confirms the full vendor inventory.
 *
 *   Phase 3 — DIFF
 *     Compare phases 1 and 2 to identify which vendors fired before consent.
 *     Vendors only in Phase 1 = pre-consent firing = finding.
 *
 * Install: npm install playwright
 * Playwright browsers: npx playwright install chromium
 */

import { chromium }             from 'playwright';
import { vendorByDomain, vendorByCookie } from '../rules/known-vendors.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCAN_TIMEOUT_MS   = 30_000;  // per-page timeout
const NAV_TIMEOUT_MS    = 20_000;  // navigation timeout
const IDLE_TIMEOUT_MS   = 3_000;   // wait for network idle after load
const VIEWPORT          = { width: 1280, height: 800 };

// Request types to ignore (not tracking-relevant)
const IGNORED_TYPES = new Set(['image', 'font', 'stylesheet', 'media', 'websocket', 'ping']);

// Domains to always exclude from findings (CDN, browser internals, etc.)
const EXCLUDED_DOMAINS  = new Set([
  'localhost', '127.0.0.1', '::1',
  'chrome-extension', 'data',
  // Common CDNs that are not trackers
  'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com',
  'fonts.googleapis.com', 'fonts.gstatic.com',
]);

// ---------------------------------------------------------------------------
// Main scan function
// ---------------------------------------------------------------------------

/**
 * Scan a single URL for pre-consent tracking.
 *
 * @param {string}  url         — fully qualified URL to scan
 * @param {object}  options
 * @param {string}  options.clientDomain  — the client's primary domain (used to distinguish first vs third party)
 * @param {string}  options.consentCookieJson  — JSON string of a "accept all" consent record
 * @param {function} options.onProgress   — optional progress callback (message: string) => void
 *
 * @returns {Promise<ScanResult>}
 */
async function scanPage(url, options = {}) {
  const {
    clientDomain  = extractDomain(url),
    consentCookieJson = buildAcceptAllCookie(url),
    onProgress    = () => {},
  } = options;

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',  // suppress background requests
    ],
  });

  try {
    onProgress(`Scanning ${url} — phase 1 (pre-consent)`);
    const phase1 = await runPhase(browser, url, clientDomain, null);

    onProgress(`Scanning ${url} — phase 2 (post-consent)`);
    const phase2 = await runPhase(browser, url, clientDomain, consentCookieJson);

    onProgress(`Scanning ${url} — analysing findings`);
    return buildFindings(url, phase1, phase2, clientDomain);

  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Single phase execution
// ---------------------------------------------------------------------------

/**
 * Load a page and record all third-party activity.
 *
 * @param {Browser}    browser
 * @param {string}     url
 * @param {string}     clientDomain
 * @param {string|null} consentCookieJson  — null = pre-consent, string = post-consent
 * @returns {Promise<PhaseData>}
 */
async function runPhase(browser, url, clientDomain, consentCookieJson) {
  const context = await browser.newContext({
    viewport:          VIEWPORT,
    userAgent:         'Mozilla/5.0 (compatible; ConsentGuardScanner/1.0)',
    ignoreHTTPSErrors: true,
    // Block geolocation, notifications etc. to simulate a clean real user
    permissions:       [],
    geolocation:       null,
  });

  // If post-consent phase, inject the consent cookie so the site's own
  // code (and ConsentGuard's loader) sees a valid stored consent record
  if (consentCookieJson) {
    const domain = new URL(url).hostname;
    await context.addCookies([{
      name:     'cg_consent',
      value:    encodeURIComponent(consentCookieJson),
      domain,
      path:     '/',
      expires:  Math.floor(Date.now() / 1000) + 365 * 86400,
      httpOnly: false,
      secure:   url.startsWith('https'),
      sameSite: 'Lax',
    }]);
  }

  const page = await context.newPage();

  // ── Network request interception ────────────────────────────────────────
  const requests  = [];
  const responses = [];

  page.on('request', (req) => {
    const type = req.resourceType();
    if (IGNORED_TYPES.has(type)) return;

    let hostname;
    try { hostname = new URL(req.url()).hostname; } catch (_) { return; }
    if (isFirstParty(hostname, clientDomain)) return;
    if (EXCLUDED_DOMAINS.has(hostname))       return;

    requests.push({
      url:      req.url(),
      hostname,
      type,
      method:   req.method(),
      headers:  sanitizeHeaders(req.headers()),
    });
  });

  page.on('response', (res) => {
    const status = res.status();
    let hostname;
    try { hostname = new URL(res.url()).hostname; } catch (_) { return; }
    if (isFirstParty(hostname, clientDomain)) return;

    responses.push({ url: res.url(), hostname, status });
  });

  // ── Console errors (may reveal blocked scripts) ─────────────────────────
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  });

  // ── Navigate ─────────────────────────────────────────────────────────────
  try {
    await page.goto(url, {
      timeout:   NAV_TIMEOUT_MS,
      waitUntil: 'networkidle',
    });
  } catch (err) {
    // networkidle timeout is common on SPAs — fall back to domcontentloaded
    try {
      await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(IDLE_TIMEOUT_MS);
    } catch (err2) {
      await context.close();
      throw new Error(`Navigation failed: ${err2.message}`);
    }
  }

  // ── Wait for post-load scripts ────────────────────────────────────────────
  await page.waitForTimeout(2000); // allow async script loads to settle

  // ── Collect cookies ───────────────────────────────────────────────────────
  const cookies = await context.cookies();
  const thirdPartyCookies = cookies.filter(c => !isFirstParty(c.domain, clientDomain));

  // ── Collect storage ───────────────────────────────────────────────────────
  const storage = await page.evaluate(() => {
    const ls = {}, ss = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      ls[k] = localStorage.getItem(k)?.slice(0, 100); // truncate values
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      ss[k] = sessionStorage.getItem(k)?.slice(0, 100);
    }
    return { localStorage: ls, sessionStorage: ss };
  }).catch(() => ({ localStorage: {}, sessionStorage: {} }));

  // ── Collect iframes ────────────────────────────────────────────────────────
  const iframes = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('iframe[src]'))
      .map(f => f.src)
      .filter(Boolean);
  }).catch(() => []);

  const thirdPartyIframes = iframes.filter(src => {
    try { return !isFirstPartyUrl(src, clientDomain); } catch (_) { return false; }
  });

  // ── Collect all script tags ────────────────────────────────────────────────
  const scripts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('script[src]'))
      .map(s => s.src)
      .filter(Boolean);
  }).catch(() => []);

  await context.close();

  return {
    requests,
    responses,
    cookies: thirdPartyCookies,
    storage,
    iframes:  thirdPartyIframes,
    scripts,
    consoleErrors,
  };
}

// ---------------------------------------------------------------------------
// Build findings from phase comparison
// ---------------------------------------------------------------------------

/**
 * Compare phase1 (pre-consent) and phase2 (post-consent) data and produce
 * structured findings.
 *
 * @param {string}     url
 * @param {PhaseData}  phase1
 * @param {PhaseData}  phase2
 * @param {string}     clientDomain
 * @returns {ScanResult}
 */
function buildFindings(url, phase1, phase2, clientDomain) {
  const findings = [];
  const vendorsSeen = new Map(); // vendorId → finding (dedup)

  // ── Step 1: Classify all requests from phase2 (full vendor inventory) ────
  const allRequestHostnames = new Set([
    ...phase2.requests.map(r => r.hostname),
    ...phase1.requests.map(r => r.hostname),
  ]);

  const preConsentHostnames = new Set(phase1.requests.map(r => r.hostname));

  for (const hostname of allRequestHostnames) {
    const vendor = vendorByDomain(hostname);
    const requestsInPhase1 = phase1.requests.filter(r => r.hostname === hostname);
    const firesBeforeConsent = preConsentHostnames.has(hostname);

    const finding = {
      type:               'script',
      hostname,
      scriptUrl:          getMostSpecificUrl(
                            [...phase1.requests, ...phase2.requests]
                            .filter(r => r.hostname === hostname)
                          ),
      vendorId:           vendor?.id        || null,
      vendorName:         vendor?.name      || hostname,
      category:           vendor?.category  || null,
      purpose:            vendor?.purpose   || null,
      mayShareData:       vendor?.mayShareData ?? null,
      isClassified:       !!vendor,
      firesBeforeConsent,
      riskLevel:          classifyRisk({
                            vendor,
                            firesBeforeConsent,
                            hostname,
                          }),
      requestCount:       requestsInPhase1.length,
      note:               vendor?.note || null,
      sensitiveCategory:  vendor?.sensitiveCategory || false,
    };

    // Deduplicate by vendorId or hostname
    const dedupeKey = vendor?.id || hostname;
    if (!vendorsSeen.has(dedupeKey)) {
      vendorsSeen.set(dedupeKey, finding);
      findings.push(finding);
    }
  }

  // ── Step 2: Cookie findings ────────────────────────────────────────────────
  const cookieFindings = [];
  const allCookies = [
    ...phase1.cookies.map(c => ({ ...c, preConsent: true  })),
    ...phase2.cookies
      .filter(c => !phase1.cookies.find(p => p.name === c.name))
      .map(c => ({ ...c, preConsent: false })),
  ];

  for (const cookie of allCookies) {
    const vendor = vendorByCookie(cookie.name);
    cookieFindings.push({
      type:               'cookie',
      cookieName:         cookie.name,
      cookieDomain:       cookie.domain,
      cookiePath:         cookie.path,
      cookieExpiry:       describeCookieDuration(cookie.expires),
      vendorId:           vendor?.id       || null,
      vendorName:         vendor?.name     || cookie.domain,
      category:           vendor?.category || null,
      isClassified:       !!vendor,
      firesBeforeConsent: cookie.preConsent,
      riskLevel:          classifyRisk({
                            vendor,
                            firesBeforeConsent: cookie.preConsent,
                            hostname: cookie.domain,
                          }),
      httpOnly:           cookie.httpOnly,
      secure:             cookie.secure,
      sameSite:           cookie.sameSite,
    });
  }

  // ── Step 3: iframe findings ────────────────────────────────────────────────
  const iframeFindings = phase1.iframes.map(src => {
    let hostname;
    try { hostname = new URL(src).hostname; } catch (_) { hostname = src; }
    const vendor = vendorByDomain(hostname);

    return {
      type:               'iframe',
      scriptUrl:          src,
      hostname,
      vendorId:           vendor?.id       || null,
      vendorName:         vendor?.name     || hostname,
      category:           vendor?.category || null,
      isClassified:       !!vendor,
      firesBeforeConsent: true,   // iframes present in phase1 load before consent by definition
      riskLevel:          classifyRisk({ vendor, firesBeforeConsent: true, hostname }),
    };
  });

  // ── Step 4: localStorage findings ─────────────────────────────────────────
  const storageFindings = [];
  for (const [key] of Object.entries(phase1.storage.localStorage || {})) {
    const vendor = vendorByCookie(key); // many vendors use matching key names in LS
    storageFindings.push({
      type:               'local_storage',
      cookieName:         key,
      vendorId:           vendor?.id       || null,
      vendorName:         vendor?.name     || 'Unknown',
      category:           vendor?.category || null,
      isClassified:       !!vendor,
      firesBeforeConsent: true,
      riskLevel:          vendor ? classifyRisk({ vendor, firesBeforeConsent: true }) : 'moderate',
    });
  }

  // ── Aggregate risk summary ────────────────────────────────────────────────
  const allFindings = [...findings, ...cookieFindings, ...iframeFindings, ...storageFindings];
  const riskCounts  = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const f of allFindings) riskCounts[f.riskLevel] = (riskCounts[f.riskLevel] || 0) + 1;

  const overallStatus =
    riskCounts.critical > 0 ? 'critical' :
    riskCounts.high     > 0 ? 'high'     :
    riskCounts.moderate > 0 ? 'moderate' : 'healthy';

  return {
    url,
    scannedAt:             new Date().toISOString(),
    overallStatus,
    riskCounts,
    scriptFindings:        findings,
    cookieFindings,
    iframeFindings,
    storageFindings,
    preConsentRequestCount: phase1.requests.length,
    totalVendorCount:       allRequestHostnames.size,
    unclassifiedCount:      findings.filter(f => !f.isClassified).length,
    preConsentVendors:      findings.filter(f => f.firesBeforeConsent).map(f => f.vendorName),
    consoleErrors:          phase1.consoleErrors.slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

function classifyRisk({ vendor, firesBeforeConsent, hostname = '' }) {
  if (!vendor) {
    // Unknown/unclassified vendor
    return firesBeforeConsent ? 'high' : 'moderate';
  }

  if (firesBeforeConsent) {
    if (vendor.riskIfPreConsent) return vendor.riskIfPreConsent;
    if (vendor.category === 'marketing')      return 'critical';
    if (vendor.category === 'analytics')      return 'high';
    if (vendor.category === 'personalization') return 'high';
    if (vendor.category === 'support')        return 'moderate';
    if (vendor.category === 'media')          return 'moderate';
    if (vendor.category === 'functional')     return 'low';
    if (vendor.category === 'essential')      return 'low';
  }

  return 'low';
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function extractDomain(url) {
  try {
    const u = new URL(url);
    const parts = u.hostname.split('.');
    return parts.slice(-2).join('.');
  } catch (_) { return url; }
}

function isFirstParty(hostname, clientDomain) {
  if (!hostname || !clientDomain) return false;
  const h = hostname.toLowerCase().replace(/^\./, '');
  const d = clientDomain.toLowerCase().replace(/^\./, '');
  return h === d || h.endsWith('.' + d);
}

function isFirstPartyUrl(url, clientDomain) {
  const hostname = new URL(url).hostname;
  return isFirstParty(hostname, clientDomain);
}

function getMostSpecificUrl(requests) {
  // Prefer script URLs over pixel/fetch URLs for reporting
  const scripts = requests.filter(r => r.type === 'script');
  if (scripts.length) return scripts[0].url;
  return requests[0]?.url || null;
}

function describeCookieDuration(expires) {
  if (!expires || expires === -1) return 'Session';
  const days = Math.round((expires * 1000 - Date.now()) / 86_400_000);
  if (days <= 0)   return 'Expired';
  if (days === 1)  return '1 day';
  if (days <= 7)   return `${days} days`;
  if (days <= 31)  return `${Math.round(days / 7)} weeks`;
  if (days <= 365) return `${Math.round(days / 30)} months`;
  return `${Math.round(days / 365)} years`;
}

function sanitizeHeaders(headers) {
  // Remove headers that may contain PII before storing
  const safe = { ...headers };
  delete safe['cookie'];
  delete safe['authorization'];
  delete safe['x-forwarded-for'];
  return safe;
}

function buildAcceptAllCookie(url) {
  const domain = extractDomain(url);
  return JSON.stringify({
    version:     '1.0',
    clientId:    'scanner',
    consentId:   'cg_scanner_' + Date.now(),
    timestamp:   new Date().toISOString(),
    source:      'banner',
    gpcDetected: false,
    categories: {
      functional:      true,
      analytics:       true,
      marketing:       true,
      personalization: true,
      support:         true,
      media:           true,
    },
  });
}

export { scanPage, buildFindings, classifyRisk };
