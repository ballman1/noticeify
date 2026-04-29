/**
 * ConsentGuard Scanner — reporters/scan-reporter.js
 *
 * Takes a ScanReport from site-crawler.js and produces:
 *   - A structured JSON payload for the dashboard API
 *   - A plain-text summary for logs / Slack alerts
 *   - A findings array formatted for the scanner_findings DB table
 *
 * The dashboard "Scanner" tab in the mockup is powered by the JSON payload.
 */

// ---------------------------------------------------------------------------
// Risk labels and icons (text only — no emoji, keep log-safe)
// ---------------------------------------------------------------------------

const RISK_LABELS = {
  critical: 'CRITICAL',
  high:     'HIGH',
  moderate: 'MODERATE',
  low:      'LOW',
};

const STATUS_LABELS = {
  critical: 'Critical issues detected',
  high:     'High-risk findings detected',
  moderate: 'Moderate findings detected',
  healthy:  'No significant issues found',
};

// ---------------------------------------------------------------------------
// Dashboard JSON payload
// ---------------------------------------------------------------------------

/**
 * Format a ScanReport for the dashboard API response.
 *
 * @param {ScanReport} report
 * @param {object}     meta    — { clientId, scanRunId, baseUrl, duration_ms }
 * @returns {object}  dashboard-ready payload
 */
function formatDashboardPayload(report, meta = {}) {
  // Split vendor findings into separate sections for the UI
  const preConsentFindings = [
    ...report.vendorFindings.filter(f => f.firesBeforeConsent),
    ...report.cookieFindings.filter(f => f.firesBeforeConsent),
  ].sort((a, b) => riskOrder(b.riskLevel) - riskOrder(a.riskLevel));

  const inventoryFindings = [
    ...report.vendorFindings,
    ...report.cookieFindings,
  ].sort((a, b) => riskOrder(b.riskLevel) - riskOrder(a.riskLevel));

  const unclassified = report.vendorFindings.filter(f => !f.isClassified);

  return {
    meta: {
      clientId:     meta.clientId    || null,
      scanRunId:    meta.scanRunId   || null,
      baseUrl:      meta.baseUrl     || null,
      generatedAt:  report.generatedAt,
      durationMs:   meta.durationMs  || null,
      pagesScanned: report.pagesScanned,
      pagesWithErrors: report.pagesWithErrors,
    },
    summary: {
      overallStatus:      report.overallStatus,
      statusLabel:        STATUS_LABELS[report.overallStatus],
      riskCounts:         report.riskCounts,
      totalVendors:       report.totalVendors,
      preConsentCount:    preConsentFindings.length,
      unclassifiedCount:  unclassified.length,
      preConsentVendors:  report.preConsentVendors,
    },
    findings: {
      preConsent:    preConsentFindings.map(formatFinding),
      inventory:     inventoryFindings.map(formatFinding),
      unclassified:  unclassified.map(formatFinding),
    },
    recommendations: generateRecommendations(report),
  };
}

function formatFinding(f) {
  return {
    type:               f.type,
    riskLevel:          f.riskLevel,
    riskLabel:          RISK_LABELS[f.riskLevel] || f.riskLevel,
    vendorName:         f.vendorName   || f.cookieName || f.hostname,
    vendorId:           f.vendorId     || null,
    category:           f.category     || null,
    purpose:            f.purpose      || null,
    scriptUrl:          f.scriptUrl    || null,
    cookieName:         f.cookieName   || null,
    cookieDuration:     f.cookieExpiry || null,
    domain:             f.hostname     || f.cookieDomain || null,
    firesBeforeConsent: !!f.firesBeforeConsent,
    isClassified:       !!f.isClassified,
    mayShareData:       f.mayShareData ?? null,
    pageUrls:           f.pageUrls     || [],
    note:               f.note         || null,
    sensitiveCategory:  f.sensitiveCategory || false,
  };
}

// ---------------------------------------------------------------------------
// Recommendations engine
// ---------------------------------------------------------------------------

/**
 * Generate actionable remediation recommendations from a scan report.
 * These appear as the "Recommended fixes" section in the dashboard.
 *
 * @param {ScanReport} report
 * @returns {object[]} recommendations
 */
function generateRecommendations(report) {
  const recs = [];

  // Critical: pre-consent marketing pixels
  const criticalPreConsent = report.vendorFindings
    .filter(f => f.firesBeforeConsent && f.riskLevel === 'critical');
  for (const v of criticalPreConsent) {
    recs.push({
      priority:    'critical',
      type:        'pre_consent_pixel',
      vendorId:    v.vendorId,
      vendorName:  v.vendorName,
      title:       `${v.vendorName} is firing before consent`,
      description: `${v.vendorName} was detected sending network requests before a consent ` +
                   `choice was recorded. This may violate CCPA and other privacy regulations. ` +
                   `Move this vendor into the ConsentGuard vendor registry and remove any ` +
                   `hardcoded or GTM tags that load it unconditionally.`,
      pageUrls:    v.pageUrls,
      action:      'Move to vendor-registry.js with category "marketing". Remove direct GTM tag.',
    });
  }

  // High: analytics firing before consent
  const highPreConsent = report.vendorFindings
    .filter(f => f.firesBeforeConsent && f.riskLevel === 'high');
  for (const v of highPreConsent) {
    recs.push({
      priority:    'high',
      type:        'pre_consent_analytics',
      vendorId:    v.vendorId,
      vendorName:  v.vendorName,
      title:       `${v.vendorName} loading before consent`,
      description: `${v.vendorName} was detected loading before a consent decision. ` +
                   `Ensure it is loaded only via the ConsentGuard vendor registry ` +
                   `after the user grants the "${v.category}" category.`,
      pageUrls:    v.pageUrls,
      action:      `Gate via ConsentManager.hasConsent('${v.category || 'analytics'}') ` +
                   `or move to vendor-registry.js.`,
    });
  }

  // GTM-specific: if GTM is detected and any marketing tags fire before consent
  const hasGTM = report.vendorFindings.some(f => f.vendorId === 'gtm');
  const hasPreConsentMarketing = report.vendorFindings
    .some(f => f.firesBeforeConsent && f.category === 'marketing');

  if (hasGTM && hasPreConsentMarketing) {
    recs.push({
      priority:    'high',
      type:        'gtm_ungated_tags',
      title:       'GTM contains ungated marketing tags',
      description: 'Google Tag Manager is deployed and marketing pixels are firing before ' +
                   'consent. Custom HTML tags inside GTM bypass Consent Mode unless explicitly ' +
                   'gated. Review all Custom HTML tags and add consent trigger conditions.',
      action:      'In GTM: add trigger condition "CG - Has Marketing Consent equals true" ' +
                   'to every marketing Custom HTML tag. See gtm-consent-config.js.',
    });
  }

  // Unclassified vendors
  if (report.unclassifiedVendors > 0) {
    const unclassified = report.vendorFindings.filter(f => !f.isClassified);
    recs.push({
      priority:    'moderate',
      type:        'unclassified_vendors',
      title:       `${report.unclassifiedVendors} unclassified third-party script(s) detected`,
      description: `The following scripts are loaded from external domains that are not in ` +
                   `the ConsentGuard vendor registry: ${unclassified.map(v => v.hostname).join(', ')}. ` +
                   `Classify each one and add it to vendor-registry.js with the appropriate category.`,
      domains:     unclassified.map(v => v.hostname),
      action:      'Add each domain to vendor-registry.js with correct category and purpose.',
    });
  }

  // Sensitive page warnings (healthcare-adjacent)
  const sensitivePaths = ['/prescription', '/rx', '/neurolux', '/ocusafe', '/ocusleep', '/migraines'];
  for (const finding of report.vendorFindings) {
    if (!finding.firesBeforeConsent || finding.category !== 'marketing') continue;
    const sensitivePage = (finding.pageUrls || []).some(url =>
      sensitivePaths.some(p => url.includes(p))
    );
    if (sensitivePage) {
      recs.push({
        priority:    'critical',
        type:        'sensitive_page_tracking',
        vendorId:    finding.vendorId,
        vendorName:  finding.vendorName,
        title:       `Marketing pixel on healthcare-adjacent page`,
        description: `${finding.vendorName} was detected on pages with prescription, vision, ` +
                     `or health-related content (${finding.pageUrls?.join(', ')}). ` +
                     `Advertising pixels on health-adjacent pages carry elevated regulatory risk.`,
        pageUrls:    finding.pageUrls,
        action:      'Remove or strictly gate this pixel on health-adjacent pages.',
      });
    }
  }

  // No issues
  if (recs.length === 0) {
    recs.push({
      priority:    'info',
      type:        'clean',
      title:       'No critical or high-risk findings',
      description: 'All detected third-party scripts appear to be properly gated behind ' +
                   'consent controls. Continue running scheduled scans to catch regressions.',
    });
  }

  // Sort: critical → high → moderate → info
  recs.sort((a, b) => riskOrder(b.priority) - riskOrder(a.priority));
  return recs;
}

// ---------------------------------------------------------------------------
// Plain text summary (for logs, Slack alerts, email notifications)
// ---------------------------------------------------------------------------

/**
 * Generate a plain-text summary of a scan report.
 *
 * @param {ScanReport} report
 * @param {object}     meta
 * @returns {string}
 */
function formatTextSummary(report, meta = {}) {
  const lines = [];
  const sep   = '─'.repeat(60);

  lines.push('ConsentGuard Scan Report');
  lines.push(sep);
  lines.push(`Site:         ${meta.baseUrl || 'unknown'}`);
  lines.push(`Scanned at:   ${report.generatedAt}`);
  lines.push(`Pages:        ${report.pagesScanned} scanned, ${report.pagesWithErrors} errors`);
  lines.push(`Status:       ${STATUS_LABELS[report.overallStatus].toUpperCase()}`);
  lines.push('');

  lines.push('Risk summary:');
  const r = report.riskCounts;
  lines.push(`  Critical: ${r.critical}  High: ${r.high}  Moderate: ${r.moderate}  Low: ${r.low}`);
  lines.push('');

  if (report.preConsentVendors.length > 0) {
    lines.push('Vendors firing BEFORE consent:');
    report.preConsentVendors.forEach(v => lines.push(`  [!] ${v}`));
    lines.push('');
  }

  if (report.unclassifiedVendors > 0) {
    const unclassified = report.vendorFindings
      .filter(f => !f.isClassified)
      .map(f => f.hostname);
    lines.push('Unclassified scripts:');
    unclassified.forEach(h => lines.push(`  [?] ${h}`));
    lines.push('');
  }

  lines.push(`Total vendors: ${report.totalVendors}`);
  lines.push(sep);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

const RISK_ORDER_MAP = { low: 0, moderate: 1, high: 2, critical: 3, info: -1 };
function riskOrder(level) { return RISK_ORDER_MAP[level] || 0; }

export { formatDashboardPayload, formatTextSummary, generateRecommendations };
