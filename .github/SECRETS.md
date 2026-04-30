# GitHub Actions — Required Secrets

Go to: **github.com/ballman1/noticeify → Settings → Secrets and variables → Actions → New repository secret**

Add each of the following:

---

## Required secrets

| Secret name | Description | Example value |
|---|---|---|
| `NOTICEIFY_API_URL` | Base URL of your deployed Vercel API | `https://noticeify-api.vercel.app` |
| `NOTICEIFY_API_KEY` | API key with `scanner:run` + `scanner:read` scopes | `nfy_live_abc123...` |
| `NOTICEIFY_CLIENT_ID` | UUID of the client row in your database | `a1b2c3d4-...` |
| `NOTICEIFY_CLIENT_DOMAIN` | Primary domain, no protocol | `39dollarglasses.com` |
| `NOTICEIFY_BASE_URL` | Full URL the scanner starts from | `https://www.39dollarglasses.com` |

## Optional secrets

| Secret name | Description |
|---|---|
| `SLACK_WEBHOOK_URL` | Incoming webhook URL for critical finding alerts. Create at api.slack.com/apps → Incoming Webhooks. If not set, the Slack step is skipped. |

---

## How to trigger a manual scan

1. Go to **Actions** tab in your GitHub repo
2. Click **Noticeify Scanner** in the left sidebar
3. Click **Run workflow** (top right of the workflow list)
4. Optionally enter an override URL (leave blank to use `NOTICEIFY_BASE_URL`)
5. Click **Run workflow**

## Schedule

The workflow runs automatically every **Monday at 2am UTC**.
To change the schedule, edit `.github/workflows/scanner.yml` and update the cron expression:

```yaml
schedule:
  - cron: '0 2 * * 1'   # Monday 2am UTC
  #        ┬ ┬ ┬ ┬ ┬
  #        │ │ │ │ └─ day of week (0=Sun, 1=Mon ... 6=Sat)
  #        │ │ │ └─── month (1-12)
  #        │ │ └───── day of month (1-31)
  #        │ └─────── hour (0-23 UTC)
  #        └───────── minute (0-59)
```

## Scan artifacts

Each run uploads a `scan-report-{run-id}` artifact containing:
- `scan-{timestamp}.json` — full structured report (dashboard payload)
- `scan-{timestamp}.txt` — plain text summary

Download from: **Actions → [workflow run] → Artifacts section**
Artifacts are retained for **30 days**.

## Alert behavior

If the scan finds **critical** findings (e.g. Meta Pixel firing before consent):
- The workflow run is marked **failed** (red) in GitHub UI
- GitHub sends email notifications to repo watchers automatically
- If `SLACK_WEBHOOK_URL` is set, a Slack message is sent with vendor names and affected pages

If there are only moderate/high findings (not critical):
- The workflow run is marked **success** (green)
- Results are still posted to the API and uploaded as artifacts
- Check the step summary in the Actions UI for the full findings table
