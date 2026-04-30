#!/usr/bin/env node
/**
 * Noticeify Scanner — scripts/run-scan.js
 *
 * Entry point for GitHub Actions (and CLI use).
 * Reads config from environment variables, runs the site scan,
 * posts results to the Noticeify API, writes artifacts to disk,
 * and sets GitHub Actions output variables for downstream steps.
 *
 * Environment variables (set as GitHub Actions secrets):
 *   NOTICEIFY_API_URL    — e.g. https://your-api.vercel.app
 *   NOTICEIFY_API_KEY    — API key with scanner:run + scanner:read scopes
 *   NOTICEIFY_CLIENT_ID  — UUID of the client to scan
 *   NOTICEIFY_CLIENT_DOMAIN — e.g. 39dollarglasses.com
 *   TARGET_URL              — e.g. https://www.39dollarglasses.com
 *   SCAN_RUN_ID             — pre-created scan run ID from the API (optional)
 *
 * Outputs (GitHub Actions):
 *   has_critical      — 'true' | 'false'
 *   critical_summary  — plain text summary of critical findings
 *   overall_status    — critical | high | moderate | healthy
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runSiteScan }   from '../core/site-crawler.js';
import {
  formatDashboardPayload,
  formatTextSummary,
} from '../reporters/scan-reporter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const API_URL     = process.env.NOTICEIFY_API_URL    || '';
const API_KEY     = process.env.NOTICEIFY_API_KEY    || '';
const CLIENT_ID   = process.env.NOTICEIFY_CLIENT_ID  || '';
const DOMAIN      = process.env.NOTICEIFY_CLIENT_DOMAIN || '';
const TARGET_URL  = process.env.TARGET_URL || (DOMAIN ? `https://www.${DOMAIN}` : '');
const SCAN_RUN_ID = process.env.SCAN_RUN_ID || null;

// ---------------------------------------------------------------------------
// GitHub Actions helpers
// ---------------------------------------------------------------------------

/**
 * Set a GitHub Actions output variable.
 * Writes to $GITHUB_OUTPUT so downstream steps can read it via
 * ${{ steps.run_scan.outputs.KEY }}
 */
function setOutput(key, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${key}=${value}\n`);
  }
  console.log(`[Output] ${key}=${value}`);
}

/**
 * Write a GitHub Actions step summary (shown in the workflow run UI).
 */
function writeSummary(markdown) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    fs.appendFileSync(summaryFile, markdown + '\n');
  }
}

// ---------------------------------------------------------------------------
// Persist artifacts to disk for upload-artifact step
// ---------------------------------------------------------------------------

function writeReportArtifacts(report, payload) {
  const reportsDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  // Full JSON report
  fs.writeFileSync(
    path.join(reportsDir, `scan-${ts}.json`),
    JSON.stringify(payload, null, 2)
  );

  // Plain text summary
  fs.writeFileSync(
    path.join(reportsDir, `scan-${ts}.txt`),
    formatTextSummary(report, { baseUrl: TARGET_URL })
  );

  console.log(`[Artifacts] Reports written to scanner/reports/`);
}

// ---------------------------------------------------------------------------
// Post results to Noticeify API
// ---------------------------------------------------------------------------

async function postResultsToApi(scanRunId, payload) {
  if (!API_URL || !API_KEY) {
    console.warn('[API] No API_URL or API_KEY — skipping API post.');
    return;
  }

  try {
    const res = await fetch(
      `${API_URL}/api/v1/scanner/runs/${scanRunId}`,
      {
        method:  'PATCH',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          status:      'completed',
          result_json: payload,
        }),
      }
    );

    if (res.ok) {
      console.log('[API] Scan results posted successfully.');
    } else {
      const text = await res.text();
      console.error(`[API] Failed to post results: ${res.status} ${text}`);
    }
  } catch (err) {
    console.error('[API] Network error posting results:', err.message);
  }
}

// ---------------------------------------------------------------------------
// GitHub Actions Step Summary
// ---------------------------------------------------------------------------

function buildMarkdownSummary(payload, baseUrl) {
  const s = payload.summary;
  const statusEmoji = {
    critical: '🔴',
    high:     '🟠',
    moderate: '🟡',
    healthy:  '🟢',
  }[s.overallStatus] || '⚪';

  const lines = [
    `## ${statusEmoji} Noticeify Scan — ${s.statusLabel}`,
    `**Site:** ${baseUrl}  `,
    `**Scanned at:** ${payload.meta.generatedAt}  `,
    `**Pages scanned:** ${payload.meta.pagesScanned}  `,
    '',
    '### Risk summary',
    `| Critical | High | Moderate | Low |`,
    `|---|---|---|---|`,
    `| ${s.riskCounts.critical} | ${s.riskCounts.high} | ${s.riskCounts.moderate} | ${s.riskCounts.low} |`,
    '',
  ];

  if (s.preConsentVendors.length > 0) {
    lines.push('### ⚠️ Vendors firing before consent');
    s.preConsentVendors.forEach(v => lines.push(`- ${v}`));
    lines.push('');
  }

  if (s.unclassifiedCount > 0) {
    lines.push(`### ❓ Unclassified scripts: ${s.unclassifiedCount}`);
    lines.push('');
  }

  if (payload.recommendations?.length) {
    lines.push('### Recommendations');
    payload.recommendations
      .filter(r => r.priority !== 'info')
      .slice(0, 5)
      .forEach(r => {
        const icon = r.priority === 'critical' ? '🔴' :
                     r.priority === 'high'     ? '🟠' : '🟡';
        lines.push(`**${icon} ${r.title}**  `);
        lines.push(`${r.description}  `);
        lines.push(`> Fix: ${r.action}  `);
        lines.push('');
      });
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Noticeify Scanner ===');
  console.log(`Target:    ${TARGET_URL}`);
  console.log(`Client:    ${CLIENT_ID}`);
  console.log(`Domain:    ${DOMAIN}`);
  console.log(`Scan run:  ${SCAN_RUN_ID || '(will be created)'}`);
  console.log('');

  if (!TARGET_URL) {
    console.error('[Error] TARGET_URL is required. Set NOTICEIFY_BASE_URL secret or pass target_url input.');
    process.exit(1);
  }

  // Create a scan run ID if none was pre-created by the workflow
  let scanRunId = SCAN_RUN_ID;
  if (!scanRunId) {
    scanRunId = `gh_${Date.now().toString(36)}`;
    console.log(`[Scanner] Generated local scan run ID: ${scanRunId}`);
  }

  const startTime = Date.now();

  try {
    const report = await runSiteScan({
      clientId:     CLIENT_ID,
      scanRunId,
      baseUrl:      TARGET_URL,
      clientDomain: DOMAIN,
      onProgress:   (msg) => console.log(`[Scanner] ${msg}`),
    });

    const durationMs = Date.now() - startTime;
    console.log(`\n[Scanner] Completed in ${(durationMs / 1000).toFixed(1)}s`);

    // Format dashboard payload
    const payload = formatDashboardPayload(report, {
      clientId:  CLIENT_ID,
      scanRunId,
      baseUrl:   TARGET_URL,
      durationMs,
    });

    // Write plain text summary to console
    console.log('\n' + formatTextSummary(report, { baseUrl: TARGET_URL }));

    // Write disk artifacts
    writeReportArtifacts(report, payload);

    // Post to API
    await postResultsToApi(scanRunId, payload);

    // Write GitHub Actions step summary
    const markdownSummary = buildMarkdownSummary(payload, TARGET_URL);
    writeSummary(markdownSummary);

    // Set GitHub Actions outputs for downstream steps
    const hasCritical = report.riskCounts.critical > 0;
    setOutput('has_critical',    String(hasCritical));
    setOutput('overall_status',  report.overallStatus);

    // Build a concise critical summary for the Slack message
    const criticalVendors = report.vendorFindings
      .filter(f => f.firesBeforeConsent && f.riskLevel === 'critical')
      .map(f => f.vendorName);
    const criticalSummary = hasCritical
      ? `${criticalVendors.join(', ')} firing before consent on ${TARGET_URL}`
      : '';
    setOutput('critical_summary', criticalSummary);

    // Exit with error code if critical findings exist
    // (workflow step "Fail on critical findings" catches this too,
    //  but setting the exit code here makes the step itself red)
    if (hasCritical) {
      console.error('\n[Scanner] Critical findings detected — exiting with code 1');
      process.exit(1);
    }

    console.log('\n[Scanner] No critical findings. Exiting cleanly.');
    process.exit(0);

  } catch (err) {
    console.error('[Scanner] Fatal error:', err.message);
    console.error(err.stack);

    setOutput('has_critical',   'false');
    setOutput('overall_status', 'failed');
    setOutput('critical_summary', '');

    // Mark the scan run as failed via API
    if (SCAN_RUN_ID && API_URL && API_KEY) {
      await fetch(`${API_URL}/api/v1/scanner/runs/${SCAN_RUN_ID}`, {
        method:  'PATCH',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          status:        'failed',
          error_message: err.message.slice(0, 500),
        }),
      }).catch(() => {});
    }

    process.exit(1);
  }
}

main();
