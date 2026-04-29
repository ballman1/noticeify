-- =============================================================================
-- ConsentGuard — Migration 002: Trigger + analytics views
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Trigger: keep consent_fingerprints current on every INSERT to consent_events
--
-- When a new consent event arrives we either:
--   a) INSERT a new fingerprint row (first visit from this browser)
--   b) UPDATE the existing row (returning visitor changed their mind)
--
-- The fingerprint is matched via the previous_consent_id chain:
--   new event's previous_consent_id == fingerprint's latest_consent_id
-- If no match, a new fingerprint is created.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION upsert_consent_fingerprint()
RETURNS TRIGGER AS $$
DECLARE
  existing_fp_id UUID;
BEGIN
  -- Try to find an existing fingerprint whose latest_consent_id matches
  -- the incoming event's previous_consent_id
  SELECT id INTO existing_fp_id
  FROM consent_fingerprints
  WHERE client_id = NEW.client_id
    AND latest_consent_id = COALESCE(NEW.previous_consent_id, NEW.consent_id)
  LIMIT 1;

  IF existing_fp_id IS NOT NULL THEN
    -- Update existing fingerprint to reflect new consent state
    UPDATE consent_fingerprints SET
      latest_consent_id   = NEW.consent_id,
      cat_functional      = NEW.cat_functional,
      cat_analytics       = NEW.cat_analytics,
      cat_marketing       = NEW.cat_marketing,
      cat_personalization = NEW.cat_personalization,
      cat_support         = NEW.cat_support,
      cat_media           = NEW.cat_media,
      gpc_detected        = NEW.gpc_detected,
      is_withdrawn        = (NEW.source = 'withdrawal'),
      last_updated_at     = NOW()
    WHERE id = existing_fp_id;
  ELSE
    -- New fingerprint — first time we've seen this browser
    INSERT INTO consent_fingerprints (
      client_id, first_consent_id, latest_consent_id,
      cat_functional, cat_analytics, cat_marketing,
      cat_personalization, cat_support, cat_media,
      gpc_detected, is_withdrawn
    ) VALUES (
      NEW.client_id, NEW.consent_id, NEW.consent_id,
      NEW.cat_functional, NEW.cat_analytics, NEW.cat_marketing,
      NEW.cat_personalization, NEW.cat_support, NEW.cat_media,
      NEW.gpc_detected, (NEW.source = 'withdrawal')
    )
    ON CONFLICT (client_id, first_consent_id) DO UPDATE SET
      latest_consent_id   = EXCLUDED.latest_consent_id,
      cat_functional      = EXCLUDED.cat_functional,
      cat_analytics       = EXCLUDED.cat_analytics,
      cat_marketing       = EXCLUDED.cat_marketing,
      cat_personalization = EXCLUDED.cat_personalization,
      cat_support         = EXCLUDED.cat_support,
      cat_media           = EXCLUDED.cat_media,
      gpc_detected        = EXCLUDED.gpc_detected,
      is_withdrawn        = EXCLUDED.is_withdrawn,
      last_updated_at     = NOW();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_upsert_consent_fingerprint
  AFTER INSERT ON consent_events
  FOR EACH ROW EXECUTE FUNCTION upsert_consent_fingerprint();

-- ---------------------------------------------------------------------------
-- View: v_consent_rates_daily
--
-- Pre-aggregated daily consent rate metrics per client.
-- Powers the dashboard charts without full-table scans.
-- Refresh strategy: materialized view refreshed nightly + on-demand.
-- ---------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS v_consent_rates_daily AS
SELECT
  client_id,
  DATE_TRUNC('day', received_at AT TIME ZONE 'UTC') AS day,

  COUNT(*)                                           AS total_events,
  COUNT(*) FILTER (WHERE source = 'banner'
    AND cat_analytics IS NOT NULL)                   AS banner_decisions,

  -- Acceptance rates
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE cat_analytics = TRUE AND cat_marketing = TRUE)
    / NULLIF(COUNT(*) FILTER (WHERE source = 'banner'), 0), 2
  )                                                  AS pct_accept_all,

  ROUND(
    100.0 * COUNT(*) FILTER (WHERE cat_analytics = FALSE AND cat_marketing = FALSE AND source = 'banner')
    / NULLIF(COUNT(*) FILTER (WHERE source = 'banner'), 0), 2
  )                                                  AS pct_reject_all,

  ROUND(
    100.0 * COUNT(*) FILTER (WHERE source = 'preference_center')
    / NULLIF(COUNT(*), 0), 2
  )                                                  AS pct_custom_prefs,

  -- Per-category grant rates (across all banner decisions)
  ROUND(100.0 * AVG(CASE WHEN cat_functional      THEN 1 ELSE 0 END)::NUMERIC, 2) AS pct_functional,
  ROUND(100.0 * AVG(CASE WHEN cat_analytics       THEN 1 ELSE 0 END)::NUMERIC, 2) AS pct_analytics,
  ROUND(100.0 * AVG(CASE WHEN cat_marketing       THEN 1 ELSE 0 END)::NUMERIC, 2) AS pct_marketing,
  ROUND(100.0 * AVG(CASE WHEN cat_personalization THEN 1 ELSE 0 END)::NUMERIC, 2) AS pct_personalization,
  ROUND(100.0 * AVG(CASE WHEN cat_support         THEN 1 ELSE 0 END)::NUMERIC, 2) AS pct_support,
  ROUND(100.0 * AVG(CASE WHEN cat_media           THEN 1 ELSE 0 END)::NUMERIC, 2) AS pct_media,

  -- Privacy signals
  COUNT(*) FILTER (WHERE gpc_detected = TRUE)        AS gpc_events,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE gpc_detected = TRUE)
    / NULLIF(COUNT(*), 0), 2
  )                                                  AS pct_gpc,

  -- Withdrawals
  COUNT(*) FILTER (WHERE source = 'withdrawal')      AS withdrawal_events

FROM consent_events
GROUP BY client_id, DATE_TRUNC('day', received_at AT TIME ZONE 'UTC')
WITH DATA;

CREATE UNIQUE INDEX idx_crd_client_day
  ON v_consent_rates_daily (client_id, day DESC);

-- ---------------------------------------------------------------------------
-- View: v_page_consent_rates
--
-- Consent rates broken down by page host + path prefix.
-- Useful for identifying high-traffic pages with low consent rates,
-- or pages (like /checkout) where pixels may be firing before consent.
-- ---------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS v_page_consent_rates AS
SELECT
  client_id,
  page_url_host,
  COUNT(*)                                             AS total_events,
  ROUND(100.0 * AVG(CASE WHEN cat_marketing  THEN 1 ELSE 0 END)::NUMERIC, 2) AS pct_marketing,
  ROUND(100.0 * AVG(CASE WHEN cat_analytics  THEN 1 ELSE 0 END)::NUMERIC, 2) AS pct_analytics,
  COUNT(*) FILTER (WHERE gpc_detected = TRUE)          AS gpc_events,
  MAX(received_at)                                     AS last_event_at
FROM consent_events
WHERE page_url_host IS NOT NULL
GROUP BY client_id, page_url_host
WITH DATA;

CREATE UNIQUE INDEX idx_pcr_client_host
  ON v_page_consent_rates (client_id, page_url_host);

-- ---------------------------------------------------------------------------
-- Function: refresh_analytics_views()
--
-- Call this from a pg_cron job or your scheduler:
--   SELECT cron.schedule('0 2 * * *', $$SELECT refresh_analytics_views()$$);
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION refresh_analytics_views()
RETURNS VOID AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY v_consent_rates_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY v_page_consent_rates;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- View: v_vendor_risk_summary
--
-- Latest scanner findings per vendor per client — used for the
-- "Vendor inventory" card in the dashboard.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_vendor_risk_summary AS
SELECT DISTINCT ON (sf.client_id, sf.vendor_key)
  sf.client_id,
  sf.vendor_key,
  sf.vendor_name,
  sf.category,
  sf.risk_level,
  sf.fires_before_consent,
  sf.is_classified,
  sf.script_url,
  sr.completed_at AS last_scanned_at
FROM scanner_findings sf
JOIN scanner_runs sr ON sr.id = sf.scan_run_id
WHERE sr.status = 'completed'
ORDER BY sf.client_id, sf.vendor_key, sr.completed_at DESC;

COMMIT;
