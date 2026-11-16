// uptime-watch: stateless website checker with Telegram alerts.
// Built to run as a scheduled Cron Job on Abasthan's free tier.
// No dependencies — Node.js >= 18 (uses built-in fetch).
//
// Environment variables:
//   TARGETS       comma-separated URLs to check, e.g. "https://a.com,https://b.com"
//   TG_BOT_TOKEN  Telegram bot token (from @BotFather)
//   TG_CHAT_ID    Telegram chat id to receive alerts
//   TIMEOUT_MS    per-request timeout in ms (default 10000)
//
// Behaviour (stateless by design — nothing is stored between runs):
//   - Every run checks all TARGETS once.
//   - If any target is down, one Telegram message lists all failures.
//   - A target that stays down is re-reported on every run; there is no
//     "recovered" message, because recovery detection needs stored state.

const targets = (process.env.TARGETS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const token = process.env.TG_BOT_TOKEN || '';
const chatId = process.env.TG_CHAT_ID || '';
const timeoutMs = parseInt(process.env.TIMEOUT_MS || '10000', 10);

async function check(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'uptime-watch/1.0' },
    });
    await res.text().catch(() => '');
    return {
      url,
      ok: res.status >= 200 && res.status < 400,
      detail: `HTTP ${res.status}`,
      ms: Date.now() - started,
    };
  } catch (e) {
    const detail =
      e && e.name === 'TimeoutError'
        ? `timeout >${timeoutMs}ms`
        : String((e && e.message) || e);
    return { url, ok: false, detail, ms: Date.now() - started };
  }
}

async function sendTelegram(text) {
  if (!token || !chatId) {
    console.log(
      '[uptime-watch] TG_BOT_TOKEN / TG_CHAT_ID not set, skipping Telegram push. Message would have been:\n' +
        text
    );
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.log(`[uptime-watch] Telegram push failed: HTTP ${res.status} ${body}`);
    }
  } catch (e) {
    console.log(`[uptime-watch] Telegram push error: ${String((e && e.message) || e)}`);
  }
}

async function main() {
  if (targets.length === 0) {
    console.log('[uptime-watch] TARGETS is empty — nothing to check. Set TARGETS and re-run.');
    return;
  }
  const results = await Promise.all(targets.map(check));
  for (const r of results) {
    console.log(
      `[uptime-watch] ${r.ok ? 'OK  ' : 'DOWN'} ${r.url} — ${r.detail} (${r.ms}ms)`
    );
  }
  const down = results.filter((r) => !r.ok);
  if (down.length > 0) {
    const lines = down
      .map((r) => `🔴 ${r.url}\n${r.detail} (${r.ms}ms)`)
      .join('\n\n');
    await sendTelegram(
      `⚠️ 网站巡检报警（${down.length} 个异常）\n\n${lines}\n\n时间：${new Date().toISOString()}`
    );
  } else {
    console.log(`[uptime-watch] All ${results.length} target(s) healthy.`);
  }
}

main().catch((e) => {
  console.error('[uptime-watch] Fatal:', e);
  process.exit(1);
});
