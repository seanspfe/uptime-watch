// uptime-watch: website checker with Telegram alerts. Zero dependencies,
// Node.js >= 18 (built-in fetch). Two run modes:
//
//   MODE=once (default) — check all targets once and exit. For cron /
//     scheduled jobs. Stateless: every failing run reports, and there is
//     no "recovered" message (recovery detection needs stored state).
//
//   MODE=loop — stay running as a background worker: check, sleep
//     INTERVAL_MINUTES, repeat. State is kept in memory, so alerts fire
//     only on transitions: once when a target goes down, once when it
//     recovers. A process restart forgets state (worst case: one repeat
//     alert after a restart).
//
// Environment variables:
//   TARGETS           comma-separated URLs, e.g. "https://a.com,https://b.com"
//   TG_BOT_TOKEN      Telegram bot token (from @BotFather)
//   TG_CHAT_ID        Telegram chat id to receive alerts
//   MODE              "once" (default) or "loop"
//   INTERVAL_MINUTES  loop interval in minutes (default 30)
//   INTERVAL_SECONDS  optional, overrides INTERVAL_MINUTES (mainly for tests)
//   TIMEOUT_MS        per-request timeout in ms (default 10000)

const targets = (process.env.TARGETS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const token = process.env.TG_BOT_TOKEN || '';
const chatId = process.env.TG_CHAT_ID || '';
const timeoutMs = parseInt(process.env.TIMEOUT_MS || '10000', 10);
const mode = (process.env.MODE || 'once').toLowerCase();
const intervalMs =
  (parseInt(process.env.INTERVAL_SECONDS || '', 10) ||
    parseInt(process.env.INTERVAL_MINUTES || '30', 10) * 60) * 1000;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One check cycle. `state` is null in once mode (report all failures), or a
// Map<url, boolean> in loop mode (report only transitions).
async function runCycle(state) {
  const results = await Promise.all(targets.map(check));
  for (const r of results) {
    console.log(
      `[uptime-watch] ${r.ok ? 'OK  ' : 'DOWN'} ${r.url} — ${r.detail} (${r.ms}ms)`
    );
  }
  const now = new Date().toISOString();
  if (state === null) {
    const down = results.filter((r) => !r.ok);
    if (down.length > 0) {
      const lines = down
        .map((r) => `🔴 ${r.url}\n${r.detail} (${r.ms}ms)`)
        .join('\n\n');
      await sendTelegram(`⚠️ 网站巡检报警（${down.length} 个异常）\n\n${lines}\n\n时间：${now}`);
    } else {
      console.log(`[uptime-watch] All ${results.length} target(s) healthy.`);
    }
    return;
  }
  const newlyDown = [];
  const recovered = [];
  for (const r of results) {
    const prev = state.get(r.url);
    if (!r.ok && prev !== false) newlyDown.push(r);
    if (r.ok && prev === false) recovered.push(r);
    state.set(r.url, r.ok);
  }
  if (newlyDown.length > 0) {
    const lines = newlyDown
      .map((r) => `🔴 ${r.url}\n${r.detail} (${r.ms}ms)`)
      .join('\n\n');
    await sendTelegram(`⚠️ 网站巡检报警（${newlyDown.length} 个新异常）\n\n${lines}\n\n时间：${now}`);
  }
  if (recovered.length > 0) {
    const lines = recovered.map((r) => `🟢 ${r.url}\n${r.detail} (${r.ms}ms)`).join('\n\n');
    await sendTelegram(`✅ 网站已恢复（${recovered.length} 个）\n\n${lines}\n\n时间：${now}`);
  }
}

async function main() {
  if (targets.length === 0) {
    console.log('[uptime-watch] TARGETS is empty — nothing to check. Set TARGETS and re-run.');
    return;
  }
  if (mode === 'loop') {
    console.log(
      `[uptime-watch] Loop mode: ${targets.length} target(s), every ${Math.round(intervalMs / 1000)}s.`
    );
    const state = new Map();
    for (;;) {
      try {
        await runCycle(state);
      } catch (e) {
        console.error('[uptime-watch] Cycle error:', e);
      }
      await sleep(intervalMs);
    }
  } else {
    await runCycle(null);
  }
}

main().catch((e) => {
  console.error('[uptime-watch] Fatal:', e);
  process.exit(1);
});
