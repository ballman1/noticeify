-- =============================================================================
-- Noticeify — Migration 003: Retention, RLS, partitioning prep
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Row-Level Security
--
-- Enforces client isolation at the database level. Even if application code
-- has a bug that omits a WHERE client_id = ? clause, Postgres will still
-- prevent cross-client data leakage.
--
-- Usage: set the session variable before any query:
--   SET app.current_client_id = 'uuid-here';
-- ---------------------------------------------------------------------------

ALTER TABLE consent_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_fingerprints   ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_registry        ENABLE ROW LEVEL SECURITY;
ALTER TABLE scanner_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE scanner_findings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys               ENABLE ROW LEVEL SECURITY;

-- Application user (non-superuser role used by the API server)
DO $$ BEGIN
  CREATE ROLE nfy_app_user NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Grant table-level access to app user
GRANT SELECT, INSERT, UPDATE ON clients              TO nfy_app_user;
GRANT SELECT, INSERT         ON consent_events       TO nfy_app_user;
GRANT SELECT, INSERT, UPDATE ON consent_fingerprints TO nfy_app_user;
GRANT SELECT, INSERT, UPDATE ON vendor_registry      TO nfy_app_user;
GRANT SELECT, INSERT, UPDATE ON scanner_runs         TO nfy_app_user;
GRANT SELECT, INSERT, UPDATE ON scanner_findings     TO nfy_app_user;
GRANT SELECT, INSERT, UPDATE ON api_keys             TO nfy_app_user;
GRANT SELECT ON v_vendor_risk_summary                TO nfy_app_user;

-- RLS policies: app user can only see rows for the current client
-- The API layer sets app.current_client_id via SET LOCAL before each query

CREATE POLICY client_isolation_consent_events ON consent_events
  FOR ALL TO nfy_app_user
  USING (client_id = current_setting('app.current_client_id', TRUE)::UUID);

CREATE POLICY client_isolation_fingerprints ON consent_fingerprints
  FOR ALL TO nfy_app_user
  USING (client_id = current_setting('app.current_client_id', TRUE)::UUID);

CREATE POLICY client_isolation_vendor_registry ON vendor_registry
  FOR ALL TO nfy_app_user
  USING (client_id = current_setting('app.current_client_id', TRUE)::UUID);

CREATE POLICY client_isolation_scanner_runs ON scanner_runs
  FOR ALL TO nfy_app_user
  USING (client_id = current_setting('app.current_client_id', TRUE)::UUID);

CREATE POLICY client_isolation_scanner_findings ON scanner_findings
  FOR ALL TO nfy_app_user
  USING (client_id = current_setting('app.current_client_id', TRUE)::UUID);

CREATE POLICY client_isolation_api_keys ON api_keys
  FOR ALL TO nfy_app_user
  USING (client_id = current_setting('app.current_client_id', TRUE)::UUID);

-- ---------------------------------------------------------------------------
-- Retention: purge_old_consent_events()
--
-- Deletes consent_events older than the client's configured retention period.
-- Also cleans up orphaned fingerprints (all events deleted = delete fingerprint).
-- Schedule with pg_cron daily: SELECT cron.schedule('0 3 * * *', $$SELECT purge_old_consent_events()$$)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION purge_old_consent_events()
RETURNS TABLE(client_id UUID, rows_deleted BIGINT) AS $$
DECLARE
  client_row RECORD;
  deleted_count BIGINT;
BEGIN
  FOR client_row IN
    SELECT id, consent_log_retention_days FROM clients WHERE deleted_at IS NULL
  LOOP
    WITH deleted AS (
      DELETE FROM consent_events ce
      WHERE  ce.client_id = client_row.id
        AND  ce.received_at < NOW() - (client_row.consent_log_retention_days || ' days')::INTERVAL
      RETURNING ce.id
    )
    SELECT COUNT(*) INTO deleted_count FROM deleted;

    client_id    := client_row.id;
    rows_deleted := deleted_count;
    RETURN NEXT;
  END LOOP;

  -- Clean up fingerprints whose entire event chain has been purged
  DELETE FROM consent_fingerprints fp
  WHERE NOT EXISTS (
    SELECT 1 FROM consent_events ce
    WHERE ce.client_id = fp.client_id
      AND ce.consent_id = fp.first_consent_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- Idempotency: prevent duplicate consent_id inserts
--
-- consent_events already has UNIQUE on consent_id. This function provides
-- a safe INSERT that silently ignores duplicates — used by the API route
-- when retrying on network errors.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION insert_consent_event_idempotent(
  p_consent_id        TEXT,
  p_client_id         UUID,
  p_previous_id       TEXT,
  p_sdk_version       TEXT,
  p_consent_version   TEXT,
  p_consented_at      TIMESTAMPTZ,
  p_source            TEXT,
  p_cat_functional    BOOLEAN,
  p_cat_analytics     BOOLEAN,
  p_cat_marketing     BOOLEAN,
  p_cat_personalization BOOLEAN,
  p_cat_support       BOOLEAN,
  p_cat_media         BOOLEAN,
  p_gpc_detected      BOOLEAN,
  p_do_not_track      BOOLEAN,
  p_page_url          TEXT,
  p_referrer          TEXT,
  p_user_agent        TEXT,
  p_language          TEXT,
  p_viewport_width    SMALLINT,
  p_viewport_height   SMALLINT,
  p_ip_address_hash   TEXT,
  p_country_code      CHAR(2),
  p_region_code       TEXT
) RETURNS BOOLEAN AS $$  -- returns TRUE if inserted, FALSE if duplicate
DECLARE
  inserted BOOLEAN;
BEGIN
  INSERT INTO consent_events (
    consent_id, client_id, previous_consent_id,
    sdk_version, consent_version, consented_at, source,
    cat_functional, cat_analytics, cat_marketing,
    cat_personalization, cat_support, cat_media,
    gpc_detected, do_not_track,
    page_url, referrer, user_agent, language,
    viewport_width, viewport_height,
    ip_address_hash, country_code, region_code
  ) VALUES (
    p_consent_id, p_client_id, p_previous_id,
    p_sdk_version, p_consent_version, p_consented_at, p_source,
    p_cat_functional, p_cat_analytics, p_cat_marketing,
    p_cat_personalization, p_cat_support, p_cat_media,
    p_gpc_detected, p_do_not_track,
    p_page_url, p_referrer, p_user_agent, p_language,
    p_viewport_width, p_viewport_height,
    p_ip_address_hash, p_country_code, p_region_code
  )
  ON CONFLICT (consent_id) DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted > 0;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Partitioning note (for high-volume deployments)
--
-- When consent_events exceeds ~10M rows, convert it to a range-partitioned
-- table by received_at (monthly partitions). The migration looks like:
--
--   CREATE TABLE consent_events_new (LIKE consent_events INCLUDING ALL)
--     PARTITION BY RANGE (received_at);
--   CREATE TABLE consent_events_2026_01
--     PARTITION OF consent_events_new
--     FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
--   -- ... etc
--   -- Then swap tables and re-create foreign keys.
--
-- For 39DollarGlasses.com at current traffic (~50k sessions/day),
-- a single table will perform well for 2+ years with the indexes in 001.
-- Revisit when the table exceeds 50M rows or query latency degrades.
-- ---------------------------------------------------------------------------

COMMIT;
