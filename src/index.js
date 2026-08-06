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

  // hourly net flow for the last 24h chart
  const hourly = await env.DB.prepare(
    `SELECT CAST(ts/3600 AS INTEGER) AS hr,
            SUM(CASE WHEN side='BUY' THEN sol_amount ELSE -sol_amount END) AS net
     FROM trades WHERE ts >= ?
     GROUP BY hr ORDER BY hr`
  ).bind(dayAgo).all();

  const totals = flows.results
    ? flows.results.reduce(
        (a, f) => ({
          net: a.net + (f.buy_sol - f.sell_sol),
          whales: a.whales + f.whales,
          trades: a.trades + f.trades,
        }),
        { net: 0, whales: 0, trades: 0 }
      )
    : { net: 0, whales: 0, trades: 0 };

  return {
    flows: flows.results || [],
    recent: recent.results || [],
    verdict,
    hourly: hourly.results || [],
    totals,
  };
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

  const { flows, recent, verdict, hourly, totals } = data;
  const minSol = env.MIN_TRADE_SOL || 25;
  const maxFlow = Math.max(1, ...flows.map((f) => Math.max(f.buy_sol, f.sell_sol)));

  const lead = flows[0];
  const leadNet = lead ? lead.buy_sol - lead.sell_sol : 0;

  // build a continuous 24h cumulative-net series for the chart
  const nowHr = Math.floor(Date.now() / 3600000);
  const byHr = {};
  hourly.forEach((h) => (byHr[h.hr] = h.net));
  const labels = [];
  const series = [];
  let cum = 0;
  for (let i = 23; i >= 0; i--) {
    const hr = nowHr - i;
    cum += byHr[hr] || 0;
    const d = new Date(hr * 3600000);
    labels.push(String(d.getUTCHours()).padStart(2, "0") + ":00");
    series.push(Math.round(cum * 10) / 10);
  }

  const flowRows = flows
    .map((f) => {
      const net = f.buy_sol - f.sell_sol;
      const pos = net >= 0;
      const buyW = (f.buy_sol / maxFlow) * 50;
      const sellW = (f.sell_sol / maxFlow) * 50;
      return `<div class="frow">
        <a class="sym" href="https://gmgn.ai/sol/token/${f.mint}" target="_blank">$${short(f.mint)}</a>
        <span class="axis">
          <span class="lft"><span class="sell" style="width:${sellW}%"></span></span>
          <span class="cen"></span>
          <span class="rgt"><span class="buy" style="width:${buyW}%"></span></span>
        </span>
        <span class="net ${pos ? "pos" : "neg"}">${pos ? "+" : ""}${net.toFixed(1)} SOL</span>
      </div>`;
    })
    .join("");

  const recentRows = recent
    .map((r, i) => {
      const c = r.side === "BUY" ? "pos" : "neg";
      const t = new Date(r.ts * 1000);
      const hm = String(t.getUTCHours()).padStart(2, "0") + ":" + String(t.getUTCMinutes()).padStart(2, "0");
      return `<div class="trow"${i === 0 ? ' style="border-top:none"' : ""}>
        <span class="tm">${hm}</span>
        <span class="side ${c}">${r.side}</span>
        <span class="tsol">${r.sol_amount.toFixed(1)} SOL</span>
        <span class="tsym">$${short(r.mint)}</span>
        <a class="tw" href="https://gmgn.ai/sol/address/${r.wallet}" target="_blank">${short(r.wallet)}</a>
      </div>`;
    })
    .join("");

  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trnchr — whale flow field report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{--paper:#F3EFE6;--ink:#2B2A26;--mut:#8A8577;--line:#C9C3B3;--faint:#DCD6C8;
        --buy:#1D7A63;--sell:#B0432A;--card:#FBF9F3;}
  *{box-sizing:border-box;margin:0}
  body{background:var(--paper);color:var(--ink);
       font:14px/1.5 "JetBrains Mono",ui-monospace,Menlo,monospace;
       padding:26px 5vw;max-width:920px;margin:0 auto}
  .serif{font-family:"Newsreader",Georgia,serif}
  .head{display:flex;align-items:flex-end;justify-content:space-between;
        border-bottom:2px solid var(--ink);padding-bottom:10px}
  .rule{height:4px;border-bottom:.5px solid var(--line);margin-bottom:20px}
  .brand{font-size:30px;font-weight:500;letter-spacing:.02em;line-height:1}
  .tag{font-size:10px;color:var(--mut);letter-spacing:.18em;margin-top:5px}
  .meta{text-align:right;font-size:10px;color:var(--mut);letter-spacing:.12em}
  .live{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--buy);margin-top:4px}
  .live b{width:6px;height:6px;border-radius:50%;background:var(--buy);display:inline-block}
  .kpis{display:grid;grid-template-columns:1.1fr 1fr 1fr;margin-bottom:24px}
  .kpi{padding:0 18px;border-right:.5px solid var(--line)}
  .kpi:first-child{padding-left:0}.kpi:last-child{border-right:none;padding-right:0}
  .klab{font-size:10px;color:var(--mut);letter-spacing:.1em;margin-bottom:4px}
  .kbig{font-size:40px;font-weight:500;line-height:1;font-variant-numeric:tabular-nums}
  .ksub{font-size:11px;color:var(--mut);margin-top:2px}
  .sec{font-size:10px;color:var(--mut);letter-spacing:.12em;margin-bottom:10px}
  .chartwrap{position:relative;width:100%;height:150px;margin-bottom:24px}
  .frow{display:grid;grid-template-columns:78px 1fr 86px;align-items:center;gap:12px;
        padding:8px 0;border-top:.5px solid var(--line)}
  .sym{font-weight:500;color:var(--ink);text-decoration:none;border-bottom:1px dotted var(--mut)}
  .axis{display:flex;align-items:center;height:15px}
  .lft{flex:1;display:flex;justify-content:flex-end}.rgt{flex:1}
  .cen{width:1px;height:17px;background:var(--ink)}
  .sell{height:13px;background:var(--sell)}.buy{display:block;height:13px;background:var(--buy)}
  .net{text-align:right;font-variant-numeric:tabular-nums}
  .pos{color:var(--buy)}.neg{color:var(--sell)}
  .dispatch{border-top:2px solid var(--ink);padding-top:12px;margin-bottom:24px}
  .dtxt{font-size:15px;line-height:1.55}
  .trow{display:grid;grid-template-columns:52px 44px 76px 1fr 92px;align-items:center;gap:8px;
        padding:7px 0;border-top:.5px solid var(--line);font-size:13px}
  .tm{color:var(--mut);font-variant-numeric:tabular-nums}
  .side{font-weight:500}.tsol{text-align:right;font-variant-numeric:tabular-nums}
  .tsym{color:var(--mut);padding-left:6px}
  .tw{text-align:right;color:var(--mut);text-decoration:none;border-bottom:1px dotted var(--line)}
  .empty{color:var(--mut);padding:14px 0;font-size:13px}
  a{color:inherit}
</style></head><body>

<div class="head">
  <div>
    <div class="brand serif">Trnchr</div>
    <div class="tag">WHALE FLOW · FIELD REPORT</div>
  </div>
  <div>
    <div class="meta">24H WINDOW · ≥${minSol} SOL</div>
    <div class="live"><b></b>COLLECTING</div>
  </div>
</div>
<div class="rule"></div>

<div class="kpis">
  <div class="kpi">
    <div class="klab">NET FLOW · ALL TOKENS</div>
    <div class="kbig serif ${totals.net >= 0 ? "pos" : "neg"}">${totals.net >= 0 ? "+" : ""}${Math.round(totals.net)}</div>
    <div class="ksub">SOL ${totals.net >= 0 ? "accumulated" : "distributed"}</div>
  </div>
  <div class="kpi">
    <div class="klab">UNIQUE WHALES</div>
    <div class="kbig serif">${totals.whales}</div>
    <div class="ksub">${totals.trades} trades</div>
  </div>
  <div class="kpi">
    <div class="klab">LEAD SIGNAL</div>
    ${lead
      ? `<div class="kbig serif ${leadNet >= 0 ? "pos" : "neg"}" style="font-size:20px;margin-top:6px">$${short(lead.mint)}</div>
         <div class="ksub">${leadNet >= 0 ? "accumulating" : "distributing"} · ${lead.whales} whales</div>`
      : `<div class="ksub" style="margin-top:8px">awaiting data</div>`}
  </div>
</div>

<div class="sec">NET FLOW · 24H (SOL)</div>
<div class="chartwrap">
  <canvas id="flowChart" role="img" aria-label="Cumulative net whale flow over the last 24 hours in SOL"></canvas>
</div>

<div class="sec">BY TOKEN &nbsp;·&nbsp; <span style="color:var(--sell)">sell ◂</span> &nbsp; <span style="color:var(--buy)">▸ buy</span></div>
${flows.length ? flowRows : `<div class="empty">No whale trades recorded yet. Once your Helius webhook fires, flows appear here.</div>`}
<div style="height:24px"></div>

<div class="dispatch">
  <div class="sec">ANALYST DISPATCH · every 6h</div>
  ${verdict ? `<div class="dtxt serif">${escapeHtml(verdict.summary)}</div>` : `<div class="empty">First dispatch lands after the next 6-hour run (00/06/12/18 UTC).</div>`}
</div>

<div class="sec">RECENT WHALE TRADES</div>
${recent.length ? recentRows : `<div class="empty">Nothing yet.</div>`}

<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>
  var L=${JSON.stringify(labels)}, D=${JSON.stringify(series)};
  new Chart(document.getElementById('flowChart'),{
    type:'line',
    data:{labels:L,datasets:[{data:D,borderColor:'#1D7A63',borderWidth:2,fill:true,
      backgroundColor:'rgba(29,122,99,0.10)',pointRadius:0,tension:0.35}]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){return c.parsed.y+' SOL net';}}}},
      scales:{x:{grid:{display:false},ticks:{color:'#8A8577',font:{size:10,family:'monospace'},maxTicksLimit:6}},
              y:{grid:{color:'#DCD6C8'},border:{display:false},ticks:{color:'#8A8577',font:{size:10,family:'monospace'}}}}}
  });
  setTimeout(function(){location.reload();},60000);
</script>
</body></html>`;

  return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
}

// ============================================================ HELPERS ======

const short = (s) => (s && s.length > 12 ? s.slice(0, 4) + "…" + s.slice(-4) : s || "");
const json = (o) => new Response(JSON.stringify(o, null, 2), { headers: { "content-type": "application/json" } });
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
