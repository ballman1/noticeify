/**
 * Noticeify — db/pool.js
 *
 * PostgreSQL connection pool using node-postgres (pg).
 * All queries go through this module — never create ad-hoc Pool instances.
 *
 * Environment variables required:
 *   DATABASE_URL  — postgres://user:pass@host:5432/dbname?sslmode=require
 *
 * Optional:
 *   DB_POOL_MAX        — max connections (default: 20)
 *   DB_IDLE_TIMEOUT_MS — idle connection timeout ms (default: 10000)
 *   DB_CONN_TIMEOUT_MS — connection acquire timeout ms (default: 5000)
 */

import pg from 'pg';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Pool configuration
// ---------------------------------------------------------------------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max:              parseInt(process.env.DB_POOL_MAX        || '20',    10),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '10000', 10),
  connectionTimeoutMillis: parseInt(process.env.DB_CONN_TIMEOUT_MS || '5000', 10),
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: true }
    : false,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// ---------------------------------------------------------------------------
// query() — standard parameterized query
// ---------------------------------------------------------------------------

/**
 * Execute a parameterized SQL query.
 *
 * @param {string}   text    — SQL with $1, $2 placeholders
 * @param {any[]}    params  — bound parameters
 * @returns {Promise<pg.QueryResult>}
 */
async function query(text, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 500) {
      console.warn('[DB] Slow query (%dms):', duration, text.slice(0, 120));
    }
    return result;
  } catch (err) {
    console.error('[DB] Query error:', err.message, '| SQL:', text.slice(0, 120));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// withClient() — for transactions and RLS session setup
//
// Usage:
//   await withClient(async (client) => {
//     await client.query("SET LOCAL app.current_client_id = $1", [clientId]);
//     await client.query("INSERT INTO consent_events ...");
//   });
// ---------------------------------------------------------------------------

/**
 * Acquire a dedicated client from the pool, run a callback, then release.
 * The callback receives the pg.Client. Handles release on error automatically.
 *
 * @param {function} fn  — async (client) => any
 * @returns {Promise<any>}
 */
async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// withTransaction() — wraps a callback in BEGIN / COMMIT / ROLLBACK
// ---------------------------------------------------------------------------

/**
 * Run an async callback inside a database transaction.
 * Automatically rolls back on error.
 *
 * @param {function} fn  — async (client) => any
 * @returns {Promise<any>}
 */
async function withTransaction(fn) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// setClientContext() — sets RLS session variable for a client
//
// Must be called inside a withClient() or withTransaction() block so
// the SET LOCAL is scoped to the same connection as the subsequent query.
// ---------------------------------------------------------------------------

/**
 * Set the RLS session variable for the current connection.
 * Use SET LOCAL so the setting is scoped to the current transaction/statement.
 *
 * @param {pg.Client} client
 * @param {string}    clientId — UUID of the Noticeify client
 */
async function setClientContext(client, clientId) {
  await client.query('SET LOCAL app.current_client_id = $1', [clientId]);
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function healthCheck() {
  const result = await query('SELECT NOW() AS now, version() AS pg_version');
  return result.rows[0];
}

export { pool, query, withClient, withTransaction, setClientContext, healthCheck };
