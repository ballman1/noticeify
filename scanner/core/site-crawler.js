/**
 * Noticeify Scanner — core/site-crawler.js
 *
 * Orchestrates a full-site scan by:
 *   1. Discovering URLs via sitemap.xml + in-page link crawling
 *   2. Prioritizing high-risk pages (checkout, cart, account, prescription)
 *   3. Running page-scanner.js on each URL with concurrency control
 *   4. Aggregating findings across all pages into a single ScanReport
 *   5. Persisting results to the database via the scan-repository
 *
 * Concurrency: scans CONCURRENCY pages in parallel. Playwright launches
 * one browser per page-scanner call; keep this low on small instances.
 * Recommended: 2–3 on a 2-core server, 4–6 on a 4-core server.
 */

import { scanPage }   from './page-scanner.js';
import * as db        from '../../backend/db/pool.js';

const CONCURRENCY       = 3;
const MAX_URLS          = 50;   // hard cap per scan run
const CRAWL_SAME_DOMAIN = true;

// Pages containing these path segments are scanned first (highest risk)
const HIGH_PRIORITY_PATHS = [
  '/checkout', '/cart', '/order', '/payment', '/account',
  '/prescription', '/rx', '/lenses', '/frames', '/sunglasses',
  '/progressive', '/reading', '/safety', '/neurolux', '/ocusafe',
];

// Paths to skip (low value, high noise)
const SKIP_PATHS = [
  '/cdn-cgi/', '/wp-admin/', '/admin/', '/.well-known/',
  '/sitemap', '/robots', '/feed', '/rss',
];

// ---------------------------------------------------------------------------
// URL discovery
// ---------------------------------------------------------------------------

/**
 * Discover URLs for a site by:
 *   1. Fetching /sitemap.xml (and any nested sitemaps)
 *   2. Falling back to crawling the homepage for links
 *
 * @param {string} baseUrl  — e.g. 'https://www.39dollarglasses.com'
 * @returns {Promise<string[]>} — deduplicated, same-domain URLs
 */
async function discoverUrls(baseUrl) {
  const discovered = new Set();
  const base = new URL(baseUrl);

  // Try sitemap first
  const sitemapUrls = await fetchSitemap(`${base.origin}/sitemap.xml`, base.origin);
  sitemapUrls.forEach(u => discovered.add(u));

  // If sitemap was sparse, supplement with a shallow homepage crawl
  if (discovered.size < 5) {
    const crawled = await crawlPage(baseUrl, base.origin);
    crawled.forEach(u => discovered.add(u));
  }

  // Always include the homepage
  discovered.add(base.origin + '/');

  return filterAndPrioritize([...discovered], base.origin);
}

/**
 * Fetch and parse a sitemap.xml. Handles sitemap indexes (nested sitemaps).
 *
 * @param {string} sitemapUrl
 * @param {string} origin
 * @returns {Promise<string[]>}
 */
async function fetchSitemap(sitemapUrl, origin) {
  const urls = [];
  try {
    const res  = await fetch(sitemapUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const text = await res.text();

    // Sitemap index — contains <sitemap><loc> entries pointing to child sitemaps
    const nestedSitemaps = [...text.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/gi)]
      .map(m => m[1].trim());
    for (const nested of nestedSitemaps.slice(0, 5)) {
      const nestedUrls = await fetchSitemap(nested, origin);
      urls.push(...nestedUrls);
    }

    // Regular sitemap — contains <url><loc> entries
    const pageUrls = [...text.matchAll(/<loc>([^<]+)<\/loc>/gi)]
      .map(m => m[1].trim())
      .filter(u => u.startsWith(origin));
    urls.push(...pageUrls);

  } catch (_) {
    // Sitemap not available — caller will fall back to crawl
  }
  return urls;
}

/**
 * Shallow crawl a page and extract all same-domain href links.
 *
 * @param {string} pageUrl
 * @param {string} origin
 * @returns {Promise<string[]>}
 */
async function crawlPage(pageUrl, origin) {
  try {
    const res  = await fetch(pageUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const html = await res.text();

    const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)]
      .map(m => {
        try {
          return new URL(m[1], pageUrl).href;
        } catch (_) { return null; }
      })
      .filter(u => u && u.startsWith(origin) && !u.includes('#'));

    return [...new Set(hrefs)];
  } catch (_) {
    return [];
  }
}

/**
 * Filter discovered URLs: remove skipped paths, deduplicate,
 * sort by priority (high-risk pages first), cap at MAX_URLS.
 */
function filterAndPrioritize(urls, origin) {
  const seen    = new Set();
  const high    = [];
  const normal  = [];

  for (const url of urls) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { continue; }

    // Same domain only
    if (CRAWL_SAME_DOMAIN && parsed.origin !== origin) continue;

    // Strip query strings and fragments for dedup
    const canonical = parsed.origin + parsed.pathname;
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    // Skip low-value paths
    const path = parsed.pathname.toLowerCase();
    if (SKIP_PATHS.some(s => path.startsWith(s))) continue;

    // Bucket by priority
    if (HIGH_PRIORITY_PATHS.some(p => path.startsWith(p))) {
      high.push(canonical);
    } else {
      normal.push(canonical);
    }
  }

  return [...high, ...normal].slice(0, MAX_URLS);
}

// ---------------------------------------------------------------------------
// Concurrent page scanning
// ---------------------------------------------------------------------------

/**
 * Scan a list of URLs with bounded concurrency.
 *
 * @param {string[]} urls
 * @param {object}   scanOptions  — passed through to scanPage()
 * @param {function} onPageDone   — callback (url, result, index, total) => void
 * @returns {Promise<Map<string, ScanResult>>}
 */
async function scanUrlsConcurrent(urls, scanOptions, onPageDone) {
  const results = new Map();
  const queue   = [...urls];
  let   index   = 0;

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      const i   = ++index;
      try {
        const result = await scanPage(url, {
          ...scanOptions,
          onProgress: (msg) => scanOptions.onProgress?.(`[${i}/${urls.length}] ${msg}`),
        });
        results.set(url, result);
        onPageDone?.(url, result, i, urls.length);
      } catch (err) {
        console.error(`[Scanner] Failed to scan ${url}:`, err.message);
        results.set(url, { url, error: err.message, overallStatus: 'failed' });
        onPageDone?.(url, null, i, urls.length);
      }
    }
  }

  // Launch CONCURRENCY workers
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker())
  );

  return results;
}

// ---------------------------------------------------------------------------
// Aggregate multi-page results into a single report
// ---------------------------------------------------------------------------

/**
 * Merge per-page scan results into a site-wide ScanReport.
 *
 * @param {Map<string, ScanResult>} pageResults
 * @returns {ScanReport}
 */
function aggregateResults(pageResults) {
  const vendorMap      = new Map(); // vendorId/hostname → aggregated finding
  const cookieMap      = new Map(); // cookie name → aggregated finding
  const allPreConsent  = new Set(); // vendor names firing before consent

  for (const [pageUrl, result] of pageResults) {
    if (!result || result.error) continue;

    // Aggregate script findings
    for (const f of (result.scriptFindings || [])) {
      const key = f.vendorId || f.hostname;
      if (!vendorMap.has(key)) {
        vendorMap.set(key, { ...f, pageUrls: [] });
      }
      const agg = vendorMap.get(key);
      agg.pageUrls.push(pageUrl);

      // Escalate risk if it fires before consent on ANY page
      if (f.firesBeforeConsent) {
        agg.firesBeforeConsent = true;
        allPreConsent.add(f.vendorName);
        // Escalate risk level if needed
        if (riskOrder(f.riskLevel) > riskOrder(agg.riskLevel)) {
          agg.riskLevel = f.riskLevel;
        }
      }
    }

    // Aggregate cookie findings
    for (const c of (result.cookieFindings || [])) {
      const key = c.cookieName;
      if (!cookieMap.has(key)) {
        cookieMap.set(key, { ...c, pageUrls: [] });
      }
      const agg = cookieMap.get(key);
      agg.pageUrls.push(pageUrl);
      if (c.firesBeforeConsent) agg.firesBeforeConsent = true;
    }
  }

  // Compute site-wide risk
  const allFindings = [...vendorMap.values(), ...cookieMap.values()];
  const riskCounts  = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const f of allFindings) {
    riskCounts[f.riskLevel] = (riskCounts[f.riskLevel] || 0) + 1;
  }

  const overallStatus =
    riskCounts.critical > 0 ? 'critical' :
    riskCounts.high     > 0 ? 'high'     :
    riskCounts.moderate > 0 ? 'moderate' : 'healthy';

  return {
    pagesScanned:         pageResults.size,
    pagesWithErrors:      [...pageResults.values()].filter(r => r?.error).length,
    overallStatus,
    riskCounts,
    vendorFindings:       [...vendorMap.values()],
    cookieFindings:       [...cookieMap.values()],
    preConsentVendors:    [...allPreConsent],
    totalVendors:         vendorMap.size,
    unclassifiedVendors:  [...vendorMap.values()].filter(v => !v.isClassified).length,
    generatedAt:          new Date().toISOString(),
  };
}

const RISK_ORDER = { low: 0, moderate: 1, high: 2, critical: 3 };
function riskOrder(level) { return RISK_ORDER[level] || 0; }

// ---------------------------------------------------------------------------
// Database persistence
// ---------------------------------------------------------------------------

/**
 * Persist a completed scan report to the database.
 *
 * @param {string}     scanRunId
 * @param {string}     clientId
 * @param {ScanReport} report
 */
async function persistScanReport(scanRunId, clientId, report) {
  await db.withTransaction(async (client) => {
    await db.setClientContext(client, clientId);

    // Update scanner_runs row to completed
    await client.query(
      `UPDATE scanner_runs SET
         status = 'completed',
         urls_crawled = $1,
         completed_at = NOW()
       WHERE id = $2`,
      [report.pagesScanned, scanRunId]
    );

    // Insert each vendor finding
    for (const finding of report.vendorFindings) {
      await client.query(
        `INSERT INTO scanner_findings (
           scan_run_id, client_id, finding_type, risk_level,
           vendor_name, vendor_key, script_url, domain,
           fires_before_consent, is_classified, category, purpose, page_urls
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          scanRunId, clientId,
          finding.type || 'script',
          finding.riskLevel,
          finding.vendorName,
          finding.vendorId,
          finding.scriptUrl,
          finding.hostname,
          finding.firesBeforeConsent,
          finding.isClassified,
          finding.category,
          finding.purpose,
          finding.pageUrls,
        ]
      );
    }

    // Insert cookie findings
    for (const finding of report.cookieFindings) {
      await client.query(
        `INSERT INTO scanner_findings (
           scan_run_id, client_id, finding_type, risk_level,
           vendor_name, vendor_key, cookie_name, cookie_duration,
           fires_before_consent, is_classified, category, page_urls
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          scanRunId, clientId,
          'cookie',
          finding.riskLevel,
          finding.vendorName,
          finding.vendorId,
          finding.cookieName,
          finding.cookieExpiry,
          finding.firesBeforeConsent,
          finding.isClassified,
          finding.category,
          finding.pageUrls,
        ]
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run a full site scan for a client.
 *
 * @param {object} options
 * @param {string}   options.clientId
 * @param {string}   options.scanRunId    — pre-created scanner_runs row ID
 * @param {string}   options.baseUrl      — e.g. 'https://www.39dollarglasses.com'
 * @param {string}   options.clientDomain — e.g. '39dollarglasses.com'
 * @param {function} options.onProgress   — (message) => void
 * @returns {Promise<ScanReport>}
 */
async function runSiteScan({ clientId, scanRunId, baseUrl, clientDomain, onProgress = () => {} }) {

  onProgress(`Discovering URLs for ${baseUrl}…`);
  const urls = await discoverUrls(baseUrl);
  onProgress(`Found ${urls.length} URLs to scan.`);

  // Mark scan as running
  await db.query(
    `UPDATE scanner_runs SET status = 'running', started_at = NOW() WHERE id = $1`,
    [scanRunId]
  );

  const pageResults = await scanUrlsConcurrent(
    urls,
    { clientDomain, onProgress },
    (url, result, i, total) => {
      const status = result?.overallStatus || 'failed';
      onProgress(`[${i}/${total}] ${url} → ${status}`);
    }
  );

  onProgress('Aggregating findings…');
  const report = aggregateResults(pageResults);

  onProgress('Saving results to database…');
  await persistScanReport(scanRunId, clientId, report);

  onProgress(`Scan complete. Overall status: ${report.overallStatus}`);
  return report;
}

export {
  runSiteScan,
  discoverUrls,
  aggregateResults,
  filterAndPrioritize,
};
