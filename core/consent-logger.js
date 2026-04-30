/**
 * Noticeify — consent-logger.js
 *
 * Sends consent records to the Noticeify backend API for audit trail
 * storage. This is what powers the dashboard's "Recent consent events" feed
 * and provides the exportable compliance log.
 *
 * Design principles:
 *   - Non-blocking: all sends are fire-and-forget; failure never disrupts UX
 *   - Privacy-minimal: IP is not collected client-side (server records it from
 *     the request if configured); we collect only what's in the spec
 *   - Retry queue: if the send fails (offline, server error), the record is
 *     queued in localStorage and retried on the next page load
 *   - Deduplication: each consentId is only sent once; a sent-IDs set in
 *     localStorage prevents double-sends on SPA navigations
 *
 * The API endpoint (/api/v1/consent) is your Noticeify backend.
 * See backend/routes/consent.js for the receiving end.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_ENDPOINT     = 'https://noticeify-w39k.vercel.app/api/v1/consent';
const RETRY_QUEUE_KEY  = 'nfy_log_queue';
const SENT_IDS_KEY     = 'nfy_sent_ids';
const MAX_RETRY_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_QUEUE_SIZE   = 20;

// ---------------------------------------------------------------------------
// Retry queue helpers
// ---------------------------------------------------------------------------

function getQueue() {
  try {
    const raw = localStorage.getItem(RETRY_QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) { return []; }
}

function setQueue(queue) {
  try { localStorage.setItem(RETRY_QUEUE_KEY, JSON.stringify(queue)); } catch (_) {}
}

function getSentIds() {
  try {
    const raw = localStorage.getItem(SENT_IDS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (_) { return new Set(); }
}

function addSentId(consentId) {
  try {
    const ids = getSentIds();
    ids.add(consentId);
    // Keep set from growing unbounded — prune to last 100 IDs
    const arr = Array.from(ids).slice(-100);
    localStorage.setItem(SENT_IDS_KEY, JSON.stringify(arr));
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Build the log payload
// ---------------------------------------------------------------------------

/**
 * Constructs the full log payload from a consent record and browser context.
 * This is what gets sent to the API and stored in the audit trail.
 *
 * @param {object} record — the consent record from consent-storage.js
 * @returns {object}
 */
function buildPayload(record) {
  const nav = navigator || {};

  return {
    // Core consent data
    consentId:      record.consentId,
    clientId:       record.clientId,
    version:        record.version,
    timestamp:      record.timestamp,
    source:         record.source,
    gpcDetected:    record.gpcDetected,
    categories:     record.categories,

    // Page context
    pageUrl:        location.href,
    pageTitle:      document.title,
    referrer:       document.referrer || null,

    // Browser context (non-identifying, used for compatibility audit)
    userAgent:      nav.userAgent || null,
    language:       nav.language  || null,
    doNotTrack:     nav.doNotTrack === '1' || nav.doNotTrack === 'yes' || false,
    // Note: IP address is recorded server-side from the request, not here.
    // We do not collect or transmit the user's IP from JavaScript.

    // Viewport (used for mobile vs desktop consent rate analysis)
    viewportWidth:  window.innerWidth  || null,
    viewportHeight: window.innerHeight || null,

    // Beacon metadata
    sdkVersion:     '1.0.0',
    sentAt:         new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Send — with Beacon API fallback
// ---------------------------------------------------------------------------

/**
 * Attempt to send a log payload to the API.
 * Uses fetch() with a keepalive flag so the request survives page unload.
 * Falls back to navigator.sendBeacon() for pagehide/unload contexts.
 *
 * @param {object}  payload
 * @param {boolean} useBeacon — force sendBeacon (for pagehide handler)
 * @returns {Promise<boolean>} — true if sent successfully
 */
async function sendPayload(payload, useBeacon = false) {
  const body = JSON.stringify(payload);

  // sendBeacon path (pagehide / visibilitychange)
  if (useBeacon && typeof navigator.sendBeacon === 'function') {
    const blob = new Blob([body], { type: 'application/json' });
    return navigator.sendBeacon(API_ENDPOINT, blob);
  }

  // Fetch path (normal operation)
  try {
    const response = await fetch(API_ENDPOINT, {
      method:    'POST',
      headers:   { 'Content-Type': 'application/json' },
      body,
      keepalive: true,         // survives page navigation
      priority:  'low',        // don't compete with page resources
    });
    return response.ok;
  } catch (_) {
    return false; // network error or fetch not available
  }
}

// ---------------------------------------------------------------------------
// Public: log a consent event
// ---------------------------------------------------------------------------

/**
 * Log a consent record. Non-blocking — returns immediately and handles
 * sending asynchronously. Queues on failure for retry.
 *
 * Called by consent-loader.js after every commitConsent().
 *
 * @param {object} record — the consent record from saveConsent()
 */
function logConsentEvent(record) {
  if (!record || !record.consentId) return;

  // Deduplication check
  const sentIds = getSentIds();
  if (sentIds.has(record.consentId)) return;

  const payload = buildPayload(record);

  // Attempt send — queue on failure
  sendPayload(payload).then(ok => {
    if (ok) {
      addSentId(record.consentId);
    } else {
      enqueue(payload);
    }
  }).catch(() => {
    enqueue(payload);
  });
}

// ---------------------------------------------------------------------------
// Retry queue
// ---------------------------------------------------------------------------

/**
 * Add a failed payload to the retry queue.
 * Prunes records older than MAX_RETRY_AGE_MS and caps queue size.
 *
 * @param {object} payload
 */
function enqueue(payload) {
  let queue = getQueue();
  const now = Date.now();

  // Remove expired entries
  queue = queue.filter(item => {
    const age = now - new Date(item.sentAt).getTime();
    return age < MAX_RETRY_AGE_MS;
  });

  // Prevent unbounded growth
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue = queue.slice(queue.length - (MAX_QUEUE_SIZE - 1));
  }

  queue.push(payload);
  setQueue(queue);
}

/**
 * Drain the retry queue. Called on page load in case previous sends failed.
 * Sends records sequentially with a small delay to avoid hammering the API.
 */
async function drainQueue() {
  const queue = getQueue();
  if (!queue.length) return;

  const remaining = [];

  for (const payload of queue) {
    // Skip if already successfully sent (e.g. user came back online)
    const sentIds = getSentIds();
    if (sentIds.has(payload.consentId)) continue;

    // Skip if record is too old
    const age = Date.now() - new Date(payload.sentAt).getTime();
    if (age > MAX_RETRY_AGE_MS) continue;

    const ok = await sendPayload(payload);
    if (ok) {
      addSentId(payload.consentId);
    } else {
      remaining.push(payload);
    }

    // Small delay between retries
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  setQueue(remaining);
}

// ---------------------------------------------------------------------------
// Pagehide handler — ensures consent is logged even on rapid navigations
// ---------------------------------------------------------------------------

/**
 * Register a pagehide handler to flush any pending consent record that
 * was queued during this page load but hasn't been sent yet.
 *
 * This is particularly important for:
 *   - Users who accept/reject and immediately navigate away
 *   - SPAs where page unload doesn't happen in the traditional sense
 */
function registerPagehideHandler(getLastRecord) {
  window.addEventListener('pagehide', () => {
    const record = getLastRecord();
    if (!record) return;

    const sentIds = getSentIds();
    if (sentIds.has(record.consentId)) return; // already sent

    const payload = buildPayload(record);
    sendPayload(payload, true); // use sendBeacon
  });
}

// ---------------------------------------------------------------------------
// Consent withdrawal log
// ---------------------------------------------------------------------------

/**
 * Log a withdrawal event. Withdrawal is a distinct event type — the
 * categories object will be null, and source will be 'withdrawal'.
 *
 * @param {string} clientId
 * @param {boolean} gpcDetected
 */
function logWithdrawal(clientId, gpcDetected) {
  const payload = {
    consentId:   'nfy_' + Date.now().toString(36) + '_withdraw',
    clientId,
    version:     'withdrawal',
    timestamp:   new Date().toISOString(),
    source:      'withdrawal',
    gpcDetected,
    categories:  null,
    pageUrl:     location.href,
    referrer:    document.referrer || null,
    userAgent:   navigator.userAgent || null,
    sdkVersion:  '1.0.0',
    sentAt:      new Date().toISOString(),
  };

  sendPayload(payload).catch(() => enqueue(payload));
}

// ---------------------------------------------------------------------------
// Init — drain queue on page load
// ---------------------------------------------------------------------------

// Drain queue after page load so it doesn't compete with critical resources
if (document.readyState === 'complete') {
  setTimeout(drainQueue, 2000);
} else {
  window.addEventListener('load', () => setTimeout(drainQueue, 2000));
}

export {
  logConsentEvent,
  logWithdrawal,
  registerPagehideHandler,
  drainQueue,
  buildPayload,
};
