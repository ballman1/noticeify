-- =============================================================================
-- Noticeify — Migration 004: Scanner result storage + scheduling
-- =============================================================================

BEGIN;

-- Store the full formatted scan result on the run record
-- (avoids a N+1 join query every time the dashboard loads scanner results)
ALTER TABLE scanner_runs
  ADD COLUMN IF NOT EXISTS result_json JSONB;

-- Index for JSONB queries on overall status
CREATE INDEX IF NOT EXISTS idx_sr_result_status
  ON scanner_runs ((result_json -> 'summary' ->> 'overallStatus'))
  WHERE result_json IS NOT NULL;

-- ---------------------------------------------------------------------------
-- scan_schedules — configures automatic periodic scanning per client
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scan_schedules (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  cron_expression TEXT    NOT NULL DEFAULT '0 2 * * 1',  -- weekly, Mon 2am UTC
  next_run_at     TIMESTAMPTZ,
  last_run_at     TIMESTAMPTZ,
  last_run_id     UUID    REFERENCES scanner_runs(id),
  notify_email    TEXT,                                   -- alert address for critical findings
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (client_id)
);

CREATE INDEX idx_ss_next_run ON scan_schedules (next_run_at)
  WHERE enabled = TRUE;

CREATE TRIGGER trg_scan_schedules_updated_at
  BEFORE UPDATE ON scan_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Function: get_due_scans()
-- Returns scan_schedules rows where next_run_at <= NOW() and enabled = TRUE.
-- Called by the scheduler worker every minute.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_due_scans()
RETURNS TABLE (
  schedule_id UUID,
  client_id   UUID,
  domain      TEXT
) AS $$
  SELECT ss.id, ss.client_id, c.domain
  FROM scan_schedules ss
  JOIN clients c ON c.id = ss.client_id
  WHERE ss.enabled = TRUE
    AND ss.next_run_at <= NOW()
    AND c.deleted_at IS NULL;
$$ LANGUAGE sql;

-- ---------------------------------------------------------------------------
-- Function: advance_scan_schedule(schedule_id)
-- Updates next_run_at after a scan is triggered.
-- Simple weekly advance — replace with pg_cron expression parser for custom schedules.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION advance_scan_schedule(p_schedule_id UUID, p_run_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE scan_schedules SET
    last_run_at = NOW(),
    last_run_id = p_run_id,
    -- Advance by 7 days for the default weekly schedule.
    -- For custom cron expressions, compute from the expression in application code.
    next_run_at = NOW() + INTERVAL '7 days',
    updated_at  = NOW()
  WHERE id = p_schedule_id;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Default schedule for 39dollarglasses.com
-- (Replace client_id with real UUID after running 001_core_schema.sql
--  and inserting the client row)
-- ---------------------------------------------------------------------------
-- INSERT INTO scan_schedules (client_id, cron_expression, next_run_at, notify_email)
-- SELECT id, '0 2 * * 1', NOW() + INTERVAL '1 minute', 'yourteam@example.com'
-- FROM clients WHERE client_key = 'nfy_39dg_prod'
-- ON CONFLICT (client_id) DO NOTHING;

COMMIT;
