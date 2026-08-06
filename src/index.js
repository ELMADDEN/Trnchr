/**
 * WHALE RADAR — a one-file Cloudflare Worker.
 *
 * What it does:
 *   1. Receives swap events from Helius webhooks  (POST /webhook?key=...)
 *   2. Keeps only trades >= MIN_TRADE_SOL and stores them in D1
 *   3. Shows accumulated whale flows at your worker URL  (GET /)
 *   4. Every 6 hours, an "analyst" cron summarises the last 24h
 *      (uses the Claude API if ANTHROPIC_API_KEY is set, otherwise
 *       writes a plain computed summary)
 *
 * Settings (set in Cloudflare dashboard -> your worker -> Settings -> Variables):
 *   WEBHOOK_SECRET      required — any password you invent; must match the ?key= in your Helius webhook URL
 *   MIN_TRADE_SOL       optional — minimum trade size in SOL to record (default 25)
 *   ANTHROPIC_API_KEY   optional — enables the AI analyst
 */

export default {
  // ---------------------------------------------------------------- HTTP ----
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, url, env);
    }
    if (url.pathname === "/api/flows") {
      const data = await getFlows(env);
      return json(data);
    }
    if (url.pathname === "/") {
      return dashboard(env);
    }
    return new Response("Not found", { status: 404 });
  },

  // ---------------------------------------------------------------- CRON ----
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAnalyst(env));
  },
};

// ============================================================ COLLECTOR ====

async function handleWebhook(request, url, env) {
  // simple auth: the URL you give Helius contains ?key=YOUR_SECRET
  if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const txs = Array.isArray(payload) ? payload : [payload];
  const minSol = parseFloat(env.MIN_TRADE_SOL || "25");
  const now = Math.floor(Date.now() / 1000);
  let stored = 0;

  for (const tx of txs) {
    const t = parseSwap(tx);
    if (!t) continue;                 // not a swap we understand
    if (t.sol_amount < minSol) continue; // too small — not a whale

    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO trades
         (signature, ts, wallet, mint, side, sol_amount, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(t.signature, t.ts, t.wallet, t.mint, t.side, t.sol_amount, now)
        .run();
      stored++;
    } catch (e) {
      console.log("insert error", e.message);
    }
  }
  return json({ ok: true, received: txs.length, stored });
}

/** Turn a Helius "enhanced" transaction into {signature, ts, wallet, mint, side, sol_amount} or null. */
function parseSwap(tx) {
  const swap = tx?.events?.swap;
  if (!swap || !tx.signature) return null;

  const ts = tx.timestamp || Math.floor(Date.now() / 1000);

  // BUY: trader pays SOL in, receives tokens out
  if (swap.nativeInput?.amount && swap.tokenOutputs?.length) {
    return {
      signature: tx.signature,
      ts,
      wallet: swap.nativeInput.account || tx.feePayer || "unknown",
      mint: swap.tokenOutputs[0].mint,
      side: "BUY",
      sol_amount: Number(swap.nativeInput.amount) / 1e9,
    };
  }
  // SELL: trader sends tokens in, receives SOL out
  if (swap.nativeOutput?.amount && swap.tokenInputs?.length) {
    return {
      signature: tx.signature,
      ts,
      wallet: swap.tokenInputs[0].userAccount || tx.feePayer || "unknown",
      mint: swap.tokenInputs[0].mint,
      side: "SELL",
      sol_amount: Number(swap.nativeOutput.amount) / 1e9,
    };
  }
  return null;
}

// ============================================================ QUERIES ======

async function getFlows(env) {
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;

  const flows = await env.DB.prepare(
    `SELECT mint,
            SUM(CASE WHEN side='BUY'  THEN sol_amount ELSE 0 END) AS buy_sol,
            SUM(CASE WHEN side='SELL' THEN sol_amount ELSE 0 END) AS sell_sol,
            COUNT(*)                       AS trades,
            COUNT(DISTINCT wallet)         AS whales
     FROM trades WHERE ts >= ?
     GROUP BY mint
     ORDER BY (buy_sol - sell_sol) DESC`
  ).bind(dayAgo).all();

  const recent = await env.DB.prepare(
    `SELECT ts, wallet, mint, side, sol_amount
     FROM trades ORDER BY ts DESC LIMIT 30`
  ).all();

  const verdict = await env.DB.prepare(
    `SELECT created_at, summary FROM verdicts ORDER BY id DESC LIMIT 1`
  ).first();

  return { flows: flows.results || [], recent: recent.results || [], verdict };
}

// ============================================================ ANALYST ======

async function runAnalyst(env) {
  const { flows } = await getFlows(env);
  if (!flows.length) return;

  const lines = flows.map(
    (f) =>
      `${f.mint}: buys ${f.buy_sol.toFixed(1)} SOL, sells ${f.sell_sol.toFixed(1)} SOL, ` +
      `net ${(f.buy_sol - f.sell_sol).toFixed(1)} SOL across ${f.trades} trades by ${f.whales} unique whales`
  );

  let summary = "Computed summary (no AI key set):\n" + lines.join("\n");

  if (env.ANTHROPIC_API_KEY) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 600,
          messages: [
            {
              role: "user",
              content:
                "You are a whale-flow analyst for Solana memecoins. " +
                "Given 24h whale flow data (trades >= a SOL threshold), state for each token: " +
                "accumulation vs distribution, conviction (how concentrated the buying is vs unique whales), " +
                "and one risk note. Be terse, no hedging boilerplate.\n\nDATA:\n" +
                lines.join("\n"),
            },
          ],
        }),
      });
      const data = await res.json();
      const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (text) summary = text;
    } catch (e) {
      console.log("analyst error", e.message);
    }
  }

  await env.DB.prepare(`INSERT INTO verdicts (created_at, summary) VALUES (?, ?)`)
    .bind(Math.floor(Date.now() / 1000), summary)
    .run();
}

// ============================================================ DASHBOARD ====

async function dashboard(env) {
  let data;
  try {
    data = await getFlows(env);
  } catch (e) {
    return new Response(
      "Database not ready. Create the D1 database, paste schema.sql into its console, " +
        "and make sure wrangler.toml has your database_id.\n\n" + e.message,
      { status: 500 }
    );
  }

  const { flows, recent, verdict } = data;
  const maxFlow = Math.max(1, ...flows.map((f) => Math.max(f.buy_sol, f.sell_sol)));

  const flowRows = flows
    .map((f) => {
      const net = f.buy_sol - f.sell_sol;
      const buyW = (f.buy_sol / maxFlow) * 100;
      const sellW = (f.sell_sol / maxFlow) * 100;
      return `<tr>
        <td class="mint"><a href="https://gmgn.ai/sol/token/${f.mint}" target="_blank">${short(f.mint)}</a></td>
        <td class="bars">
          <div class="axis">
            <div class="sell" style="width:${sellW / 2}%"></div>
            <div class="buy"  style="width:${buyW / 2}%"></div>
          </div>
        </td>
        <td class="num ${net >= 0 ? "pos" : "neg"}">${net >= 0 ? "+" : ""}${net.toFixed(1)}</td>
        <td class="num">${f.buy_sol.toFixed(1)}</td>
        <td class="num">${f.sell_sol.toFixed(1)}</td>
        <td class="num">${f.trades}</td>
        <td class="num">${f.whales}</td>
      </tr>`;
    })
    .join("");

  const recentRows = recent
    .map(
      (r) => `<tr>
        <td class="num">${new Date(r.ts * 1000).toISOString().slice(5, 16).replace("T", " ")}</td>
        <td class="${r.side === "BUY" ? "pos" : "neg"}">${r.side}</td>
        <td class="num">${r.sol_amount.toFixed(1)}</td>
        <td class="mint">${short(r.mint)}</td>
        <td class="mint"><a href="https://gmgn.ai/sol/address/${r.wallet}" target="_blank">${short(r.wallet)}</a></td>
      </tr>`
    )
    .join("");

  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Whale Radar</title>
<style>
  :root{--bg:#071119;--panel:#0D1E2C;--line:#16344A;--txt:#E4ECF2;--mut:#7C93A6;
        --buy:#3FD0C0;--sell:#F0705E;--sand:#D8C08F;}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--txt);
       font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:28px 4vw}
  h1{font-size:17px;letter-spacing:.25em;color:var(--sand);font-weight:600}
  h1 .dot{color:var(--buy)}
  .sub{color:var(--mut);font-size:12px;margin:4px 0 26px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:6px;
          padding:18px 20px;margin-bottom:22px}
  h2{font-size:11px;letter-spacing:.2em;color:var(--mut);font-weight:600;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{color:var(--mut);font-weight:500;text-align:right;padding:4px 8px;font-size:11px;letter-spacing:.08em}
  th:first-child,td.mint{text-align:left}
  td{padding:6px 8px;border-top:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums}
  td.mint a{color:var(--txt);text-decoration:none;border-bottom:1px dotted var(--mut)}
  .pos{color:var(--buy)} .neg{color:var(--sell)}
  .bars{width:34%} .axis{display:flex;justify-content:center;height:10px;position:relative}
  .axis::before{content:"";position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--line)}
  .buy{background:var(--buy);height:100%;border-radius:0 3px 3px 0}
  .sell{background:var(--sell);height:100%;border-radius:3px 0 0 3px;margin-left:auto}
  .axis{gap:0}.sell{order:1}.buy{order:2}
  pre{white-space:pre-wrap;color:var(--txt);font-size:13px}
  .empty{color:var(--mut);padding:14px 0}
</style></head><body>
<h1>WHALE RADAR <span class="dot">●</span></h1>
<div class="sub">accumulated whale flows · last 24h · trades ≥ ${env.MIN_TRADE_SOL || 25} SOL · auto-refresh 60s</div>

<section><h2>NET FLOW BY TOKEN (SOL)</h2>
${flows.length ? `<table><tr><th>TOKEN</th><th>SELL ◂ ▸ BUY</th><th>NET</th><th>BUYS</th><th>SELLS</th><th>TRADES</th><th>WHALES</th></tr>${flowRows}</table>`
               : `<div class="empty">No whale trades recorded yet. Once your Helius webhook fires, flows appear here.</div>`}
</section>

<section><h2>ANALYST — LATEST VERDICT (EVERY 6H)</h2>
${verdict ? `<pre>${escapeHtml(verdict.summary)}</pre>` : `<div class="empty">First verdict lands after the next 6-hour cron run.</div>`}
</section>

<section><h2>RECENT WHALE TRADES</h2>
${recent.length ? `<table><tr><th>UTC</th><th>SIDE</th><th>SOL</th><th>TOKEN</th><th>WALLET</th></tr>${recentRows}</table>`
                : `<div class="empty">Nothing yet.</div>`}
</section>
<script>setTimeout(()=>location.reload(),60000)</script>
</body></html>`;

  return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
}

// ============================================================ HELPERS ======

const short = (s) => (s && s.length > 12 ? s.slice(0, 4) + "…" + s.slice(-4) : s || "");
const json = (o) => new Response(JSON.stringify(o, null, 2), { headers: { "content-type": "application/json" } });
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
