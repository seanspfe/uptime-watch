# uptime-watch

Stateless website uptime checker with Telegram alerts. Built to run as a
scheduled **Cron Job on Abasthan** (free tier), but works anywhere Node.js ≥ 18
runs. Zero dependencies.

Two run modes:

- **`MODE=once`** (default) — check every URL in `TARGETS` once and exit, for
  cron / scheduled jobs. If any target is down (network error, timeout, or
  HTTP status outside 200–399), one Telegram message lists all failures.
- **`MODE=loop`** — stay running as a background worker: check, sleep
  `INTERVAL_MINUTES`, repeat. State is kept in memory, so alerts fire only on
  transitions — once when a target goes down, once when it recovers.

## Environment variables

| Name               | Required | Meaning                                                        |
| ------------------ | -------- | -------------------------------------------------------------- |
| `TARGETS`          | yes      | Comma-separated URLs, e.g. `https://a.com,https://b.com`       |
| `TG_BOT_TOKEN`     | yes*     | Telegram bot token from @BotFather                             |
| `TG_CHAT_ID`       | yes*     | Chat id that receives the alerts                               |
| `MODE`             | no       | `once` (default) or `loop`                                     |
| `INTERVAL_MINUTES` | no       | Loop interval in minutes (default `30`)                        |
| `TIMEOUT_MS`       | no       | Per-request timeout in ms (default `10000`)                    |

\* Without the Telegram variables the checks still run and log, and the alert
text is printed to the log instead of being sent — useful for a first test run.

## Behaviour notes

- **Once mode is stateless**: nothing is stored between runs, so a target that
  stays down is **re-reported on every run**, and there is no "recovered"
  message. Pick the schedule interval with that in mind.
- **Loop mode keeps state in memory only**: a process restart forgets it, so
  the worst case after a restart is one repeat alert. In return you get
  transition-only alerts and recovery messages.

## Run locally

```bash
# one-shot
TARGETS="https://example.com" TG_BOT_TOKEN="..." TG_CHAT_ID="..." node index.js

# background-worker loop
MODE=loop INTERVAL_MINUTES=30 TARGETS="https://example.com" \
  TG_BOT_TOKEN="..." TG_CHAT_ID="..." node index.js
```

## Deploy on Abasthan

Abasthan's console (as of 2026-11) does not actually offer the advertised
Cron Job type, so deploy as a **Background Worker**:

1. Create App → **Background Worker**, source: this (public) Git repository.
2. Runtime Node.js, start command `node index.js`.
3. Environment: `MODE=loop`, `INTERVAL_MINUTES=30`, plus `TARGETS`,
   `TG_BOT_TOKEN`, `TG_CHAT_ID` from the table above.
