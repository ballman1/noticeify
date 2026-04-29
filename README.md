# ConsentGuard — Consent Loader & Vendor Registry

JavaScript implementation of the ConsentGuard consent loader for
39dollarglasses.com. This is the critical-path module that prevents
non-essential scripts from loading before affirmative user consent.

---

## File map

```
consentguard/
├── core/
│   ├── consent-loader.js     ← Main engine. Import/embed this.
│   ├── consent-storage.js    ← Cookie + localStorage read/write
│   ├── consent-mode.js       ← Google Consent Mode v2 signals
│   ├── consent-ui.js         ← Banner + preference center (lazy-loaded)
│   ├── consent-logger.js     ← POSTs consent records to audit API
│   ├── gpc.js                ← Global Privacy Control detection
│   └── media-embed-gate.js   ← YouTube/Vimeo iframe blocking
│
├── registry/
│   └── vendor-registry.js    ← All third-party scripts, classified & gated
│
└── gtm/
    └── gtm-consent-config.js ← GTM setup instructions + dataLayer helpers
```

---

## Execution order (critical)

```
<head> loads consent-loader.js
  │
  ├── setConsentModeDefaults()     ← All Google signals → denied
  ├── loadEssentialVendors()       ← GTM loads (but its tags are still gated)
  ├── isGPCEnabled()               ← Check navigator.globalPrivacyControl
  │
  ├── [stored consent found?]
  │     YES → applyConsent()  → updateConsentMode() → loadApprovedVendors()
  │     NO  → showBanner()    → user action → commitConsent() → applyConsent()
  │
  └── window.ConsentManager API exposed
```

---

## Embed snippet (place first in `<head>`)

```html
<script
  src="https://cdn.consentguard.io/cg.js"
  data-client-id="cg_39dg_prod"
  data-domain="39dollarglasses.com"
  async>
</script>
```

**Important:** This tag must be the first `<script>` in `<head>`, before GTM,
before any analytics snippet, before anything. If placed after GTM, Google tags
may fire before Consent Mode defaults are set.

---

## Public API (window.ConsentManager)

```javascript
// Check if a category was granted
if (window.ConsentManager.hasConsent('marketing')) {
  // safe to fire marketing-dependent code
}

// Get the full consent record
const record = window.ConsentManager.getConsent();
// → { consentId, timestamp, categories, gpcDetected, version, ... }

// Open the preference center (e.g. from footer link)
window.ConsentManager.openPreferences();

// Programmatically update consent (e.g. from server-side sync)
window.ConsentManager.updateConsent({ analytics: true, marketing: false, ... });

// Withdraw all consent
window.ConsentManager.withdrawConsent();

// React to consent changes
window.ConsentManager.onConsentChange(({ categories }) => {
  if (categories?.analytics) {
    // analytics just became available — initialize anything
    // that couldn't wait for page load
  }
});
```

---

## Adding a new vendor

Open `registry/vendor-registry.js` and add an entry to `VENDOR_REGISTRY`:

```javascript
{
  id:       'new-vendor-id',
  name:     'New Vendor Name',
  category: 'analytics',           // one of the 7 category keys
  load() {
    // inject the script here
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://vendor.example.com/script.js';
    document.head.appendChild(s);
  },
  cookies:      ['vendor_cookie'],
  purpose:      'One sentence describing what this vendor does.',
  mayShareData: false,
  owner:        'team-name',
  lastReviewed: '2026-04-29',
},
```

The loader will automatically call `load()` when the matching category
is granted. No other changes needed.

**Never hardcode a non-essential script directly into the page template.**
All non-essential third-party scripts must go through this registry.

---

## Category keys

| Key               | Google Consent Mode signals                            |
|-------------------|--------------------------------------------------------|
| `essential`       | Always loads. No gate.                                 |
| `functional`      | functionality_storage, personalization_storage         |
| `analytics`       | analytics_storage                                      |
| `marketing`       | ad_storage, ad_user_data, ad_personalization           |
| `personalization` | personalization_storage                                |
| `support`         | (no Consent Mode signal — load/block directly)         |
| `media`           | (no Consent Mode signal — iframe gate in media-embed-gate.js) |

---

## Media embeds (YouTube / Vimeo)

Replace `src` with `data-cg-src` on any third-party iframe:

```html
<!-- BEFORE -->
<iframe src="https://www.youtube.com/embed/VIDEO_ID" ...></iframe>

<!-- AFTER -->
<iframe
  data-cg-src="https://www.youtube.com/embed/VIDEO_ID"
  data-cg-category="media"
  width="560" height="315"
  frameborder="0"
></iframe>
```

`media-embed-gate.js` will replace it with a consent-aware placeholder
and swap in the real iframe when the user grants the `media` category.

---

## GPC behavior

When `navigator.globalPrivacyControl === true`:

- `marketing` and `personalization` are forced to `false` regardless of
  what the user clicks on the banner (including "Accept All").
- The stored consent record is annotated with `gpcDetected: true`.
- A visible GPC notice is shown on the banner.
- The user can still opt into `analytics`, `functional`, etc.

To allow users to override GPC for marketing (non-default, requires
legal sign-off), set `config.allowGPCOverride = true` in the init call.

---

## Cookie written by ConsentGuard

```
Name:     cg_consent
Value:    URI-encoded JSON consent record
Expires:  365 days
Path:     /
SameSite: Lax
Secure:   set on HTTPS
HttpOnly: no (must be JS-readable)
```

The consent record shape:

```json
{
  "version": "1.0",
  "clientId": "cg_39dg_prod",
  "consentId": "cg_lf2k3a_x7m2n1",
  "timestamp": "2026-04-29T14:38:00.000Z",
  "source": "banner",
  "gpcDetected": false,
  "categories": {
    "functional": true,
    "analytics": true,
    "marketing": false,
    "personalization": false,
    "support": false,
    "media": false
  }
}
```

---

## Backend API

```
backend/
├── app.js                         ← Express entry point
├── package.json
├── db/
│   └── pool.js                    ← pg connection pool + RLS helpers
├── middleware/
│   └── auth.js                    ← API key validation + origin check
├── routes/
│   └── consent.js                 ← POST /api/v1/consent + GET stats/export
└── migrations/
    ├── 001_core_schema.sql         ← Tables: clients, consent_events, vendor_registry, etc.
    ├── 002_triggers_and_views.sql  ← Fingerprint trigger, materialized views
    └── 003_retention_rls.sql       ← Row-level security, retention function
```

### Apply migrations

```bash
psql $DATABASE_URL -f backend/migrations/001_core_schema.sql
psql $DATABASE_URL -f backend/migrations/002_triggers_and_views.sql
psql $DATABASE_URL -f backend/migrations/003_retention_rls.sql
```

### Run the API

```bash
cd backend
npm install
DATABASE_URL=postgres://... IP_HASH_SALT=your-secret npm start
```

### Key design decisions

**Append-only consent log** — `consent_events` rows are never updated or deleted (except by the retention function). Every preference change creates a new row with a `previous_consent_id` pointer to the prior choice. This gives you a full auditable history.

**IP anonymization** — raw IPs are never stored. The IP is HMAC-hashed with a daily rotating salt, so the same IP on the same day produces the same hash (useful for dedup/rate limiting) but can't be correlated across days.

**Idempotent writes** — the `insert_consent_event_idempotent()` DB function uses `ON CONFLICT DO NOTHING` on `consent_id`. The retry queue in `consent-logger.js` can safely re-send without creating duplicates.

**Row-level security** — every table has a Postgres RLS policy. The API sets `SET LOCAL app.current_client_id = ?` before each query so cross-client data leakage is impossible even if application code omits a `WHERE client_id = ?` clause.

**Materialized views** — `v_consent_rates_daily` pre-aggregates daily metrics so dashboard queries are fast regardless of table size. Refresh nightly via `SELECT refresh_analytics_views()`.

## Scanner

```
scanner/
├── core/
│   ├── page-scanner.js      ← Playwright page scan (3-phase: pre/post/diff)
│   └── site-crawler.js      ← URL discovery + concurrent multi-page scan
├── reporters/
│   └── scan-reporter.js     ← Formats findings for dashboard, logs, alerts
├── rules/
│   └── known-vendors.js     ← Fingerprint DB: 25+ vendors, domain/cookie indexes
└── package.json             ← Playwright dependency
```

### Install Playwright

```bash
cd scanner
npm install
npx playwright install chromium
```

### Trigger a scan via API

```bash
curl -X POST https://your-api/api/v1/scanner/run/<clientId> \
  -H "Authorization: Bearer <api-key>"
# → { scanRunId: "...", status: "pending" }

# Poll for results
curl https://your-api/api/v1/scanner/runs/<scanRunId> \
  -H "Authorization: Bearer <api-key>"
```

### How the scanner works

**3-phase scan per URL.** For each page, the scanner runs two full browser sessions back to back:

Phase 1 (pre-consent) loads the page in a clean context with no cookies and no consent record. Every third-party network request, cookie, and localStorage entry is recorded. This is the ground truth for what fires before a user makes any choice.

Phase 2 (post-consent) loads the same page after injecting a simulated "accept all" `cg_consent` cookie. The full vendor inventory fires. This gives you the complete list of all third-party scripts on the site.

The diff between phases 1 and 2 identifies exactly which vendors fire before consent. Anything in phase 1 that wasn't supposed to be there is a finding.

**URL discovery.** The crawler fetches `/sitemap.xml` first (handles nested sitemap indexes), falls back to shallow link-crawling the homepage, and always includes the root. High-risk paths — `/checkout`, `/cart`, `/prescription`, `/neurolux`, `/ocusafe` — are sorted to the front of the queue so the most legally sensitive pages are scanned first within the MAX_URLS cap.

**Risk classification.** Each finding gets a risk level based on two factors: the vendor's category (marketing = higher risk) and whether it fires before consent (pre-consent = escalated risk). A Meta Pixel firing before consent is `critical`. An unclassified unknown domain firing before consent is `high`. Zendesk loading before the user opens chat is `moderate`.

**Recommendations engine.** `scan-reporter.js` generates specific, actionable remediation steps — not just "you have a problem." Each recommendation names the vendor, the affected pages, and the exact fix (e.g. "Move to vendor-registry.js with category 'marketing'. Remove GTM Custom HTML tag.").

### Schedule automatic scans

Insert a row into `scan_schedules` and the scheduler worker (run separately) will call `GET /api/v1/scanner/run/:clientId` on the configured interval. Default is weekly Monday 2am UTC.

```sql
INSERT INTO scan_schedules (client_id, next_run_at, notify_email)
SELECT id, NOW() + INTERVAL '1 minute', 'your@email.com'
FROM clients WHERE client_key = 'cg_39dg_prod';
```



1. Replace all placeholder IDs in `registry/vendor-registry.js` with
   real account IDs before deploying
2. Point `API_ENDPOINT` in `consent-logger.js` to your actual backend URL
3. Build the backend `/api/v1/consent` route — see `consent-logger.js`
   `buildPayload()` for the full shape of what gets POSTed
4. Follow GTM setup instructions in `gtm/gtm-consent-config.js` to gate
   Custom HTML tags inside your GTM container (especially Klaviyo)

---

## What this does NOT include (yet)

- Server-side consent log API (backend `/api/v1/consent` route)
- Sec-GPC header detection (server middleware)
- Consent version migration logic (for when you bump `CONSENT_VERSION`)
- Safari ITP / cookie lifespan workarounds
- Consent A/B testing hooks
- Multi-language support
