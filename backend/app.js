/**
 * ConsentGuard — app.js
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

const app  = express();
const PORT = process.env.PORT || 3001;

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

app.use('/api/v1/consent',        consentWriteLimit);
app.use('/api/v1/consent/stats',  dashboardReadLimit);
app.use('/api/v1/consent/export', dashboardReadLimit);

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
    res.json({ status: 'ok', db: { now: db.now } });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: err.message });
  }
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

app.listen(PORT, () => {
  console.log(`[ConsentGuard API] Listening on port ${PORT}`);
  console.log(`[ConsentGuard API] NODE_ENV=${process.env.NODE_ENV || 'development'}`);
});

export default app;
