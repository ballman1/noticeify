-- =============================================================================
-- ConsentGuard — Migration 001: Core schema
-- =============================================================================
-- Run order: 001 → 002 → 003
-- Engine: PostgreSQL 14+
-- Apply with: psql $DATABASE_URL -f 001_core_schema.sql
--             or your migration runner (Flyway, node-pg-migrate, etc.)
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "pgcrypto";    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- trigram indexes for text search

-- ---------------------------------------------------------------------------
-- clients
--
-- One row per website using ConsentGuard. The clientId written into the
-- browser cookie (e.g. "cg_39dg_prod") references this table.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS clients (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_key          TEXT        NOT NULL UNIQUE,  -- matches data-client-id on embed tag
  name                TEXT        NOT NULL,          -- human: "39 Dollar Glasses"
  legal_name          TEXT,
  domain              TEXT        NOT NULL,
  additional_domains  TEXT[]      DEFAULT '{}',
  privacy_policy_url  TEXT,
  cookie_policy_url   TEXT,
  privacy_choices_url TEXT,
  terms_url           TEXT,

  -- Jurisdiction & feature flags
  default_jurisdiction  TEXT    DEFAULT 'US',
  gpc_enabled           BOOLEAN DEFAULT TRUE,
  healthcare_adjacent   BOOLEAN DEFAULT FALSE,  -- enables stricter pixel controls

  -- Consent Mode
  gcm_enabled           BOOLEAN DEFAULT TRUE,

  -- Log retention
  consent_log_retention_days  INTEGER DEFAULT 365,

  -- Timestamps
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ                           -- soft delete
);

CREATE INDEX idx_clients_client_key ON clients (client_key);
CREATE INDEX idx_clients_domain     ON clients (domain);

-- ---------------------------------------------------------------------------
-- consent_events
--
-- One row per consent decision. This is the audit trail.
-- Append-only by design — never UPDATE or DELETE rows. Withdrawals and
-- changes create new rows with source='withdrawal' or source='preference_center'.
--
-- The previous_consent_id column creates a linked list of consent history
-- for a given browser (identified by consent_fingerprint — see below).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS consent_events (

  -- Identity
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_id        TEXT        NOT NULL UNIQUE,  -- from browser (cg_xxx_yyy)
  client_id         UUID        NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,

  -- Versioning — tells you exactly what banner/policy the user saw
  sdk_version       TEXT        NOT NULL DEFAULT '1.0.0',
  consent_version   TEXT        NOT NULL,          -- from CONSENT_VERSION in storage.js
  previous_consent_id TEXT,                        -- last consent_id for this fingerprint

  -- Timing
  consented_at      TIMESTAMPTZ NOT NULL,          -- from browser timestamp
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when server got it

  -- Source
  source            TEXT        NOT NULL           -- banner | preference_center | api | withdrawal | gpc
    CHECK (source IN ('banner','preference_center','api','withdrawal','gpc')),

  -- Categories granted (NULL = withdrawal event where all are revoked)
  cat_functional      BOOLEAN,
  cat_analytics       BOOLEAN,
  cat_marketing       BOOLEAN,
  cat_personalization BOOLEAN,
  cat_support         BOOLEAN,
  cat_media           BOOLEAN,

  -- Privacy signals
  gpc_detected      BOOLEAN     NOT NULL DEFAULT FALSE,
  do_not_track      BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Page context
  page_url          TEXT,
  page_url_host     TEXT        GENERATED ALWAYS AS (
                      -- Extract just the host for bucketing/analysis without
                      -- storing full URLs in indexes (can contain PII in params)
                      CASE
                        WHEN page_url ~ '^https?://' THEN
                          regexp_replace(page_url, '^https?://([^/?#]+).*$', '\1')
                        ELSE NULL
                      END
                    ) STORED,
  referrer          TEXT,

  -- Browser context
  user_agent        TEXT,
  language          TEXT,
  viewport_width    SMALLINT,
  viewport_height   SMALLINT,

  -- Network (recorded server-side, not from JS)
  ip_address_hash   TEXT,   -- SHA-256 of IP + daily salt — never raw IP
  country_code      CHAR(2), -- from IP geolocation, not stored in raw form
  region_code       TEXT,    -- state/province code

  -- Integrity
  request_id        UUID    DEFAULT gen_random_uuid(),  -- for idempotency
  user_agent_hash   TEXT    GENERATED ALWAYS AS (
                      encode(digest(COALESCE(user_agent,''), 'sha256'), 'hex')
                    ) STORED

);

-- Core lookup indexes
CREATE INDEX idx_ce_client_id       ON consent_events (client_id);
CREATE INDEX idx_ce_consented_at    ON consent_events (consented_at DESC);
CREATE INDEX idx_ce_received_at     ON consent_events (received_at  DESC);
CREATE INDEX idx_ce_source          ON consent_events (source);
CREATE INDEX idx_ce_gpc_detected    ON consent_events (gpc_detected) WHERE gpc_detected = TRUE;
CREATE INDEX idx_ce_country         ON consent_events (country_code);

-- Composite index for the most common dashboard query:
-- "all events for client X in date range, ordered by time"
CREATE INDEX idx_ce_client_time
  ON consent_events (client_id, received_at DESC);

-- Composite index for consent rate calculations
CREATE INDEX idx_ce_client_source_time
  ON consent_events (client_id, source, received_at DESC);

-- Partial index for withdrawal events (compliance queries)
CREATE INDEX idx_ce_withdrawals
  ON consent_events (client_id, consented_at DESC)
  WHERE source = 'withdrawal';

-- Page URL host for per-page analysis (without full URL PII)
CREATE INDEX idx_ce_page_host
  ON consent_events (client_id, page_url_host, received_at DESC)
  WHERE page_url_host IS NOT NULL;

-- ---------------------------------------------------------------------------
-- consent_fingerprints
--
-- Maps a browser fingerprint (consent_id chain) to its latest consent state.
-- This is a materialized view of the "current" state per browser, used for
-- the real-time consent check API and for linking consent history chains.
--
-- Updated by trigger on consent_events INSERT.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS consent_fingerprints (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- The browser-side consent_id that first established this fingerprint.
  -- Subsequent events from the same browser arrive via previous_consent_id chain.
  first_consent_id  TEXT        NOT NULL,
  latest_consent_id TEXT        NOT NULL,

  -- Denormalized current state for fast lookups (updated by trigger)
  cat_functional      BOOLEAN,
  cat_analytics       BOOLEAN,
  cat_marketing       BOOLEAN,
  cat_personalization BOOLEAN,
  cat_support         BOOLEAN,
  cat_media           BOOLEAN,
  gpc_detected        BOOLEAN   DEFAULT FALSE,
  is_withdrawn        BOOLEAN   DEFAULT FALSE,

  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (client_id, first_consent_id)
);

CREATE INDEX idx_cf_client_id         ON consent_fingerprints (client_id);
CREATE INDEX idx_cf_latest_consent_id ON consent_fingerprints (latest_consent_id);
CREATE INDEX idx_cf_last_updated      ON consent_fingerprints (client_id, last_updated_at DESC);

-- ---------------------------------------------------------------------------
-- vendor_registry
--
-- Server-side mirror of vendor-registry.js. Kept in sync by the admin UI.
-- Used for the scanner dashboard and for audit reports.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vendor_registry (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  vendor_key      TEXT    NOT NULL,    -- matches id in vendor-registry.js
  name            TEXT    NOT NULL,
  category        TEXT    NOT NULL
    CHECK (category IN ('essential','functional','analytics','marketing',
                        'personalization','support','media')),
  script_url      TEXT,
  cookie_names    TEXT[]  DEFAULT '{}',
  purpose         TEXT,
  may_share_data  BOOLEAN DEFAULT FALSE,
  is_active       BOOLEAN DEFAULT TRUE,
  owner           TEXT,
  last_reviewed   DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (client_id, vendor_key)
);

CREATE INDEX idx_vr_client_id ON vendor_registry (client_id);
CREATE INDEX idx_vr_category  ON vendor_registry (client_id, category);

-- ---------------------------------------------------------------------------
-- scanner_runs
--
-- Records each scan execution. Child rows go in scanner_findings.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scanner_runs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  triggered_by  TEXT        DEFAULT 'scheduled'  -- scheduled | manual | api
    CHECK (triggered_by IN ('scheduled','manual','api')),
  status        TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed')),
  urls_crawled  INTEGER     DEFAULT 0,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sr_client_id   ON scanner_runs (client_id);
CREATE INDEX idx_sr_created_at  ON scanner_runs (client_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- scanner_findings
--
-- One row per detected script/cookie/pixel, per scan run.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scanner_findings (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_run_id     UUID    NOT NULL REFERENCES scanner_runs(id) ON DELETE CASCADE,
  client_id       UUID    NOT NULL REFERENCES clients(id)     ON DELETE CASCADE,

  finding_type    TEXT    NOT NULL
    CHECK (finding_type IN ('script','cookie','iframe','pixel','local_storage','unknown')),
  risk_level      TEXT    NOT NULL DEFAULT 'low'
    CHECK (risk_level IN ('low','moderate','high','critical')),

  vendor_name     TEXT,
  vendor_key      TEXT,                   -- FK to vendor_registry.vendor_key if matched
  script_url      TEXT,
  domain          TEXT,
  cookie_name     TEXT,
  cookie_duration TEXT,
  fires_before_consent  BOOLEAN DEFAULT FALSE,
  is_classified   BOOLEAN DEFAULT TRUE,   -- FALSE = unknown/unregistered vendor
  category        TEXT,
  purpose         TEXT,
  page_urls       TEXT[]  DEFAULT '{}',   -- which pages it was found on
  notes           TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sf_scan_run_id ON scanner_findings (scan_run_id);
CREATE INDEX idx_sf_client_id   ON scanner_findings (client_id);
CREATE INDEX idx_sf_risk_level  ON scanner_findings (client_id, risk_level);
CREATE INDEX idx_sf_pre_consent ON scanner_findings (client_id, fires_before_consent)
  WHERE fires_before_consent = TRUE;

-- ---------------------------------------------------------------------------
-- api_keys
--
-- API keys for client dashboard access and server-to-server integrations.
-- Keys are stored as bcrypt hashes — the raw key is shown once at creation.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_keys (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  key_hash    TEXT    NOT NULL,   -- bcrypt hash of the raw key
  key_prefix  TEXT    NOT NULL,   -- first 8 chars, for display/identification
  name        TEXT    NOT NULL,   -- "Production embed", "Dashboard read-only", etc.
  scopes      TEXT[]  NOT NULL DEFAULT '{}',  -- e.g. ['consent:write', 'logs:read']
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ak_client_id  ON api_keys (client_id);
CREATE INDEX idx_ak_key_prefix ON api_keys (key_prefix);

-- ---------------------------------------------------------------------------
-- updated_at auto-update trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_vendor_registry_updated_at
  BEFORE UPDATE ON vendor_registry
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
