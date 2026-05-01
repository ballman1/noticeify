/**
 * Noticeify — app.js
 *
 * Express application entry point.
 *
 * Environment variables:
 *   PORT            — HTTP port (default: 3001)
 *   DATABASE_URL    — postgres://...
 *   IP_HASH_SALT    — random string for daily IP hashing (REQUIRED in prod)
 *   TRUST_PROXY     — set to 'true' if behind a reverse proxy (Nginx, Cloudflare)
 *   NODE_ENV        — 'production' | 'development'
 *   CORS_ORIGINS    — comma-separated list of allowed origins (or '*' for dev)
 *
 * Install:
 *   npm install express helmet cors express-rate-limit pg
 */

import express       from 'express';
import helmet        from 'helmet';
import cors          from 'cors';
import rateLimit     from 'express-rate-limit';
import { healthCheck } from './db/pool.js';
import consentRoutes   from './routes/consent.js';
import scannerRoutes   from './routes/scanner.js';
import {
  startScannerWorker,
  stopScannerWorker,
  getScannerWorkerMetrics,
} from './scanner/worker.js';

const app  = express();
const PORT = process.env.PORT || 3001;

if (process.env.NODE_ENV === 'production' && !process.env.IP_HASH_SALT) {
  throw new Error('IP_HASH_SALT is required when NODE_ENV=production');
}

// ---------------------------------------------------------------------------
// Trust proxy (required for correct req.ip behind Nginx / Cloudflare)
// ---------------------------------------------------------------------------

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

app.use(helmet({
  contentSecurityPolicy: false, // API only — no HTML responses
  crossOriginEmbedderPolicy: false,
}));

// ---------------------------------------------------------------------------
// CORS
//
// The consent.js POST endpoint must accept requests from client websites
// (cross-origin). Dashboard API should be locked to the dashboard origin.
// ---------------------------------------------------------------------------

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['*'];

app.use('/api/v1/consent', cors({
  origin:  corsOrigins,
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  maxAge: 86400, // cache preflight for 24h
}));

app.use('/api/v1/scanner', cors({
  origin:  corsOrigins,
  methods: ['POST', 'GET', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  maxAge: 86400,
}));

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

app.use(express.json({ limit: '32kb' })); // consent payloads are small

// ---------------------------------------------------------------------------
// Rate limiting
//
// Per-IP limits to protect against:
//   a) Accidental spam from broken retry loops
//   b) Deliberate log flooding to exhaust storage
//
// The consent:write endpoint is more permissive (one per user action)
// but still capped to block abuse.
// ---------------------------------------------------------------------------

const consentWriteLimit = rateLimit({
  windowMs:         60_000,   // 1 minute window
  max:              30,        // 30 consent writes per IP per minute
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'rate_limit_exceeded', retryAfter: 60 },
  skip: (req) => process.env.NODE_ENV === 'development',
});

const dashboardReadLimit = rateLimit({
  windowMs:         60_000,
  max:              120,       // 120 dashboard reads per minute
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'rate_limit_exceeded', retryAfter: 60 },
});

const scannerRunLimit = rateLimit({
  windowMs:         60_000,
  max:              10,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'rate_limit_exceeded', retryAfter: 60 },
});

app.use('/api/v1/consent',        consentWriteLimit);
app.use('/api/v1/consent/stats',  dashboardReadLimit);
app.use('/api/v1/consent/export', dashboardReadLimit);
app.use('/api/v1/scanner/run',    scannerRunLimit);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/api/v1/consent', consentRoutes);
app.use('/api/v1/scanner', scannerRoutes);

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/health', async (req, res) => {
  try {
    const db = await healthCheck();
    res.json({
      status: 'ok',
      db: { now: db.now },
      scannerWorker: getScannerWorkerMetrics(),
    });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: err.message });
  }
});

app.get('/metrics', (req, res) => {
  const m = getScannerWorkerMetrics();
  const lines = [
    '# HELP noticeify_scanner_claims_total Total claimed scanner jobs.',
    '# TYPE noticeify_scanner_claims_total counter',
    `noticeify_scanner_claims_total ${m.claims ?? 0}`,
    '# HELP noticeify_scanner_completed_total Total completed scanner jobs.',
    '# TYPE noticeify_scanner_completed_total counter',
    `noticeify_scanner_completed_total ${m.completed ?? 0}`,
    '# HELP noticeify_scanner_failed_total Total failed scanner jobs.',
    '# TYPE noticeify_scanner_failed_total counter',
    `noticeify_scanner_failed_total ${m.failed ?? 0}`,
    '# HELP noticeify_scanner_worker_started Scanner worker started state.',
    '# TYPE noticeify_scanner_worker_started gauge',
    `noticeify_scanner_worker_started ${m.workerStarted ? 1 : 0}`,
    '# HELP noticeify_scanner_worker_processing Scanner worker processing state.',
    '# TYPE noticeify_scanner_worker_processing gauge',
    `noticeify_scanner_worker_processing ${m.isProcessing ? 1 : 0}`,
  ];

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[App] Unhandled error:', err.message, err.stack);
  res.status(500).json({ error: 'internal_error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`[Noticeify API] Listening on port ${PORT}`);
  console.log(`[Noticeify API] NODE_ENV=${process.env.NODE_ENV || 'development'}`);
  startScannerWorker().catch((err) => {
    console.error('[Noticeify API] Scanner worker startup failed:', err.message);
  });
});

async function shutdown(signal) {
  console.log(`[Noticeify API] Received ${signal}, shutting down...`);
  await stopScannerWorker();
  const m = getScannerWorkerMetrics();
  if (m.isProcessing) {
    console.warn('[Noticeify API] Worker still processing during shutdown timeout.');
  }
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((err) => {
    console.error('[Noticeify API] Shutdown error:', err.message);
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((err) => {
    console.error('[Noticeify API] Shutdown error:', err.message);
    process.exit(1);
  });
});

export default app;
