# uptime-watch

Stateless website uptime checker with Telegram alerts. Built to run as a
scheduled **Cron Job on Abasthan** (free tier), but works anywhere Node.js ≥ 18
runs. Zero dependencies.

Each run checks every URL in `TARGETS` once. If any target is down (network
error, timeout, or HTTP status outside 200–399), one Telegram message lists
all failures.

## Environment variables

| Name           | Required | Meaning                                                        |
| -------------- | -------- | -------------------------------------------------------------- |
| `TARGETS`      | yes      | Comma-separated URLs, e.g. `https://a.com,https://b.com`       |
| `TG_BOT_TOKEN` | yes*     | Telegram bot token from @BotFather                             |
| `TG_CHAT_ID`   | yes*     | Chat id that receives the alerts                               |
| `TIMEOUT_MS`   | no       | Per-request timeout in ms (default `10000`)                    |

\* Without the Telegram variables the checks still run and log, and the alert
text is printed to the log instead of being sent — useful for a first test run.

## Behaviour notes (stateless by design)

- Nothing is stored between runs, so a target that stays down is **re-reported
  on every run**. Pick the schedule interval with that in mind (30 minutes is
  a reasonable default).
- There is **no "recovered" message** — detecting recovery needs stored state,
  which this deliberately avoids so it can run on platforms without persistent
  storage.

## Run locally

```bash
TARGETS="https://example.com" TG_BOT_TOKEN="..." TG_CHAT_ID="..." node index.js
```

## Deploy on Abasthan

1. Create App → **Cron Job**, source: this (public) Git repository.
2. Runtime Node.js, start command `node index.js`.
3. Schedule: `*/30 * * * *` (every 30 minutes) or as you prefer.
4. Set the environment variables above in the service settings.
