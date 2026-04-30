/**
 * Noticeify — backend/api/index.js
 *
 * Vercel serverless entry point.
 * Imports the Express app and exports it as the default handler.
 * Vercel's @vercel/node runtime calls this as a serverless function.
 *
 * The only change from the standard Express app: we remove app.listen()
 * (Vercel manages the server lifecycle) and export the app instead.
 */

import express       from 'express';
import helmet        from 'helmet';
import cors          from 'cors';
import rateLimit     from 'express-rate-limit';
import { healthCheck } from '../db/pool.js';
import consentRoutes   from '../routes/consent.js';
import scannerRoutes   from '../routes/scanner.js';

const app = express();

// Trust proxy — Vercel sits behind a proxy
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy:      false,
  crossOriginEmbedderPolicy:  false,
}));

// CORS
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['*'];

app.use('/api/v1/consent', cors({
  origin:         corsOrigins,
  methods:        ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  maxAge:         86400,
}));

app.use('/api/v1/scanner', cors({
  origin:         corsOrigins,
  methods:        ['POST', 'GET', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  maxAge:         86400,
}));

// Body parsing
app.use(express.json({ limit: '32kb' }));

// Rate limiting
const consentWriteLimit = rateLimit({
  windowMs:        60_000,
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'rate_limit_exceeded', retryAfter: 60 },
});

const dashboardReadLimit = rateLimit({
  windowMs:        60_000,
  max:             120,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'rate_limit_exceeded', retryAfter: 60 },
});

app.use('/api/v1/consent',        consentWriteLimit);
app.use('/api/v1/consent/stats',  dashboardReadLimit);
app.use('/api/v1/consent/export', dashboardReadLimit);

// Routes
app.use('/api/v1/consent', consentRoutes);
app.use('/api/v1/scanner', scannerRoutes);

// Health check
app.get('/health', async (req, res) => {
  try {
    const db = await healthCheck();
    res.json({ status: 'ok', db: { now: db.now } });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: err.message });
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[App] Unhandled error:', err.message);
  res.status(500).json({ error: 'internal_error' });
});

// Export for Vercel — do NOT call app.listen() here
export default app;
