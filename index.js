// uptime-watch: website checker with Telegram alerts and a built-in status
// page. Zero dependencies, Node.js >= 18 (built-in fetch + http).
//
// Run modes (MODE env):
//   once (default) — check all targets once and exit. For cron / scheduled
//     jobs. Stateless: every failing run reports; no "recovered" message.
//   loop — stay running as a background worker: check, sleep
//     INTERVAL_MINUTES, repeat. State in memory: alerts fire only on
//     transitions (down once, recovered once). A restart forgets state
//     (worst case: one repeat alert).
//   web — like loop, plus an HTTP server on $PORT (default 8080) serving a
//     live status page at / and a plain health check at /healthz. For PaaS
//     web services (e.g. Abasthan) that require the app to bind $PORT.
//
// Environment variables:
//   TARGETS           comma-separated URLs, e.g. "https://a.com,https://b.com"
//   TG_BOT_TOKEN      Telegram bot token (from @BotFather)
//   TG_CHAT_ID        Telegram chat id to receive alerts
//   MODE              "once" (default), "loop" or "web"
//   PORT              web mode listen port (platform-injected; default 8080)
//   INTERVAL_MINUTES  check interval in minutes (default 30)
//   INTERVAL_SECONDS  optional, overrides INTERVAL_MINUTES (mainly for tests)
//   TIMEOUT_MS        per-request timeout in ms (default 10000)

import http from 'node:http';

const targets = (process.env.TARGETS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const token = process.env.TG_BOT_TOKEN || '';
const chatId = process.env.TG_CHAT_ID || '';
const timeoutMs = parseInt(process.env.TIMEOUT_MS || '10000', 10);
const mode = (process.env.MODE || 'once').toLowerCase();
const port = parseInt(process.env.PORT || '8080', 10);
const intervalMs =
  (parseInt(process.env.INTERVAL_SECONDS || '', 10) ||
    parseInt(process.env.INTERVAL_MINUTES || '30', 10) * 60) * 1000;

// Latest result per target, for the status page.
const latest = new Map();
let lastCycleAt = null;

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
// Map<url, boolean> in loop/web mode (report only transitions).
async function runCycle(state) {
  const results = await Promise.all(targets.map(check));
  lastCycleAt = new Date();
  for (const r of results) {
    latest.set(r.url, { ...r, at: lastCycleAt });
    console.log(
      `[uptime-watch] ${r.ok ? 'OK  ' : 'DOWN'} ${r.url} — ${r.detail} (${r.ms}ms)`
    );
  }
  const now = lastCycleAt.toISOString();
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

function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function statusPage() {
  const rows = targets
    .map((url) => {
      const r = latest.get(url);
      if (!r) {
        return `<tr><td>⏳</td><td>${esc(url)}</td><td>等待首次巡检</td><td>-</td></tr>`;
      }
      return `<tr><td>${r.ok ? '🟢' : '🔴'}</td><td>${esc(url)}</td><td>${
        r.ok ? '正常' : '异常'
      } · ${esc(r.detail)}</td><td>${r.ms}ms</td></tr>`;
    })
    .join('\n');
  const downCount = [...latest.values()].filter((r) => !r.ok).length;
  const summary =
    latest.size === 0
      ? '巡检尚未完成第一轮'
      : downCount === 0
        ? `全部 ${latest.size} 个站点正常`
        : `${downCount} 个站点异常`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>网站巡检状态</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:2rem auto;max-width:760px;padding:0 1rem;color:#1a1a1a}
table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #e5e5e5;padding:.5rem .4rem;text-align:left;font-size:.95rem}
small{color:#666}
</style>
</head>
<body>
<h1>网站巡检状态</h1>
<p>${esc(summary)}</p>
<table>
<tr><th></th><th>网址</th><th>状态</th><th>响应</th></tr>
${rows}
</table>
<p><small>最近巡检：${lastCycleAt ? esc(lastCycleAt.toISOString()) : '—'} · 每 ${
    intervalMs >= 90000
      ? `${Math.round(intervalMs / 60000)} 分钟`
      : `${Math.round(intervalMs / 1000)} 秒`
  }一轮 · 页面每 60 秒自动刷新</small></p>
</body>
</html>`;
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(statusPage());
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[uptime-watch] Status page listening on 0.0.0.0:${port}`);
  });
}

async function loopForever() {
  const state = new Map();
  for (;;) {
    try {
      await runCycle(state);
    } catch (e) {
      console.error('[uptime-watch] Cycle error:', e);
    }
    await sleep(intervalMs);
  }
}

async function main() {
  if (targets.length === 0) {
    console.log('[uptime-watch] TARGETS is empty — nothing to check. Set TARGETS and re-run.');
    if (mode !== 'web') return;
  }
  if (mode === 'web') {
    console.log(
      `[uptime-watch] Web mode: ${targets.length} target(s), every ${Math.round(intervalMs / 1000)}s, port ${port}.`
    );
    startServer();
    await loopForever();
  } else if (mode === 'loop') {
    console.log(
      `[uptime-watch] Loop mode: ${targets.length} target(s), every ${Math.round(intervalMs / 1000)}s.`
    );
    await loopForever();
  } else {
    await runCycle(null);
  }
}

main().catch((e) => {
  console.error('[uptime-watch] Fatal:', e);
  process.exit(1);
});
