# Noticeify Feature Stabilization Task List

This task list captures feature gaps and likely broken behavior discovered during a repository review.

## P0 — Fix immediately

1. **Replace stubbed geolocation enrichment in consent ingestion**
   - **Issue:** `geoLookup()` always returns `null` country/region, so geo-based analytics and compliance reporting are effectively non-functional.
   - **Impact:** Dashboard geo segmentation and region-specific compliance insights are unavailable.
   - **Tasks:**
     - Implement real IP→geo lookup (MaxMind or API provider).
     - Add timeout/fallback behavior so `/api/v1/consent` never blocks indefinitely.
     - Add unit tests for successful lookup and provider failure fallback.

2. **Move scanner execution to a durable worker/job system**
   - **Issue:** scan jobs are kicked off with `setImmediate()` inside the API process, which is brittle for restarts, autoscaling, and serverless/runtime recycling.
   - **Impact:** Scans may silently fail or disappear when the API process is interrupted.
   - **Tasks:**
     - Introduce queue-backed execution (e.g., BullMQ/SQS/Cloud Tasks).
     - Persist intermediate progress and heartbeat.
     - Add retry policy and terminal failure reason taxonomy.

3. **Remove default insecure IP salt fallback**
   - **Issue:** IP hashing uses a default `'change-me-in-production'` salt when `IP_HASH_SALT` is missing.
   - **Impact:** Weakens privacy guarantees and can create predictable hashes across deployments.
   - **Tasks:**
     - Fail fast at startup when `IP_HASH_SALT` is absent in production.
     - Add configuration validation and startup diagnostics.

## P1 — High priority

4. **Wire scanner findings persistence consistently with dashboard stats queries**
   - **Issue:** consent stats rely on `scanner_findings` and latest `scanner_runs`, but route-side scan orchestration currently only guarantees `scanner_runs.result_json` updates.
   - **Impact:** `preConsentCount` and risk summaries can be stale or empty if findings persistence isn’t reliably completed.
   - **Tasks:**
     - Verify and enforce persistence contract from crawler output to `scanner_findings` rows.
     - Add integration test: trigger scan → completed run → stats reflect findings.

5. **Implement real dashboard data integration (replace static demo UX)**
   - **Issue:** `dashboard/index.html` is currently a static, demo-style single file with mocked interactions and no API data-binding layer.
   - **Impact:** Product pages appear functional but do not reflect live consent/scanner data.
   - **Tasks:**
     - Add API client for consent logs, stats, and scanner endpoints.
     - Implement auth token handling and error states.
     - Replace mock values with real metrics.

6. **Add scanner endpoint hardening (rate limiting + origin/CORS policy alignment)**
   - **Issue:** consent endpoints have explicit CORS and rate limiting, but scanner endpoints lack equivalent perimeter controls.
   - **Impact:** Higher abuse risk (expensive scan trigger endpoint).
   - **Tasks:**
     - Add route-specific rate limits for `/api/v1/scanner/*`.
     - Align CORS policy for scanner routes with dashboard origins.

## P2 — Quality and correctness improvements

7. **Tighten payload validation for category schema**
   - **Issue:** payload validation checks `categories` is an object but does not strictly validate allowed keys/value types.
   - **Impact:** Malformed category payloads can enter storage and skew analytics.
   - **Tasks:**
     - Validate each category key and boolean type.
     - Reject unknown category keys.

8. **Add automated tests (currently minimal/absent in runtime paths)**
   - **Issue:** backend declares `node --test`, but there are no visible route-level/integration test suites for critical endpoints.
   - **Impact:** Regressions are likely in consent ingestion, exports, and scanner orchestration.
   - **Tasks:**
     - Add tests for `/api/v1/consent` validation/idempotency.
     - Add tests for pagination and CSV export.
     - Add scanner route tests for concurrency guard and status polling.
