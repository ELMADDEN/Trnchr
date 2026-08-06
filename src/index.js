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

  const netPos = totals.net >= 0;
  const heroColor = netPos ? "#12b886" : "#ff5a4d";

  let buySol = 0, sellSol = 0;
  flows.forEach((f) => { buySol += f.buy_sol; sellSol += f.sell_sol; });

  // 24h cumulative-net series for the dot pulse
  const nowHr = Math.floor(Date.now() / 3600000);
  const byHr = {};
  hourly.forEach((h) => (byHr[h.hr] = h.net));
  const series = [];
  let cum = 0;
  for (let i = 23; i >= 0; i--) {
    cum += byHr[nowHr - i] || 0;
    series.push(Math.round(cum * 10) / 10);
  }

  const flowRows = flows
    .map((f, i) => {
      const net = f.buy_sol - f.sell_sol;
      const pos = net >= 0;
      const sw = (f.sell_sol / maxFlow) * 50;
      const bw = (f.buy_sol / maxFlow) * 50;
      return `<div class="frow"${i === 0 ? ' style="border-top:none"' : ""}>
        <a class="sym" href="https://gmgn.ai/sol/token/${f.mint}" target="_blank">$${short(f.mint)}</a>
        <span class="axis">
          <span class="lft"><span class="sell" style="width:${sw}%"></span></span>
          <span class="cen"></span>
          <span class="rgt"><span class="buy" style="width:${bw}%"></span></span>
        </span>
        <span class="net ${pos ? "pos" : "neg"}">${pos ? "+" : ""}${net.toFixed(1)}</span>
      </div>`;
    })
    .join("");

  const recentRows = recent
    .map((r, i) => {
      const isBuy = r.side === "BUY";
      const t = new Date(r.ts * 1000);
      const hm = String(t.getUTCHours()).padStart(2, "0") + ":" + String(t.getUTCMinutes()).padStart(2, "0");
      return `<div class="trow"${i === 0 ? ' style="border-top:none"' : ""}>
        <span class="tm">${hm}</span>
        <span class="side ${isBuy ? "pos" : "neg"}">${r.side}</span>
        <span class="tsol">${r.sol_amount.toFixed(1)} SOL</span>
        <span class="tsym">$${short(r.mint)}</span>
        <a class="tw" href="https://gmgn.ai/sol/address/${r.wallet}" target="_blank">${short(r.wallet)}</a>
      </div>`;
    })
    .join("");

  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trnchr — whale flow</title>
<style>
  :root{--teal:#12b886;--coral:#ff5a4d;--ink:#0b0b0d;--mut:#8a8a90;--mut2:#b0b0b6;
        --line:#eeeeef;--card:#fff;--page:#e8e8ea;}
  *{box-sizing:border-box;margin:0}
  body{background:var(--page);
       font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif;
       color:var(--ink);padding:16px;max-width:760px;margin:0 auto}
  .hero{background:var(--ink);border-radius:18px;padding:22px 22px 6px;margin-bottom:12px;overflow:hidden}
  .htop{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .brand{font-size:18px;font-weight:600;letter-spacing:-0.01em;color:#fff}
  .htag{font-size:11px;color:#6b6b70;margin-left:9px}
  .live{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--teal)}
  .live b{width:6px;height:6px;border-radius:50%;background:var(--teal);display:inline-block}
  .hlab{font-size:12px;color:#6b6b70;margin-bottom:2px}
  .hero-num{font-size:56px;font-weight:600;letter-spacing:-0.03em;line-height:1}
  .hsub{font-size:15px;color:#6b6b70;margin-left:10px;font-weight:400}
  .pulsewrap{position:relative;height:80px;margin:6px -6px -2px}
  .cards{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px}
  .card{background:var(--card);border-radius:14px;padding:14px 16px}
  .clab{font-size:11px;color:var(--mut);margin-bottom:8px}
  .cnum{font-size:26px;font-weight:600;letter-spacing:-0.02em}
  .csub{font-size:11px;color:var(--mut);margin-top:2px}
  .panel{background:var(--card);border-radius:14px;padding:16px 18px;margin-bottom:12px}
  .phead{font-size:12px;color:var(--mut);margin-bottom:12px;display:flex;justify-content:space-between}
  .frow{display:grid;grid-template-columns:110px 1fr 74px;align-items:center;gap:12px;padding:9px 0;border-top:0.5px solid var(--line)}
  .sym{font-size:13px;font-weight:500;color:var(--ink);text-decoration:none}
  .axis{display:flex;align-items:center;height:14px}
  .lft{flex:1;display:flex;justify-content:flex-end}.rgt{flex:1}
  .cen{width:1px;height:16px;background:#e0e0e4}
  .sell{height:8px;background:var(--coral);border-radius:4px 0 0 4px}
  .buy{display:block;height:8px;background:var(--teal);border-radius:0 4px 4px 0}
  .net{text-align:right;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
  .pos{color:var(--teal)}.neg{color:var(--coral)}
  .disp{background:var(--card);border-radius:14px;padding:16px 18px;margin-bottom:12px}
  .dtxt{font-size:14px;line-height:1.55;color:var(--ink)}
  .trow{display:grid;grid-template-columns:46px 42px 74px 1fr 82px;align-items:center;gap:8px;padding:8px 0;border-top:0.5px solid var(--line);font-size:12px}
  .tm{color:var(--mut);font-variant-numeric:tabular-nums}
  .side{font-weight:600}.tsol{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
  .tsym{color:var(--mut);padding-left:8px}
  .tw{text-align:right;color:var(--mut2);text-decoration:none}
  .empty{color:var(--mut);padding:10px 0;font-size:13px}
</style></head><body>

<div class="hero">
  <div class="htop">
    <div><span class="brand">Trnchr</span><span class="htag">whale flow</span></div>
    <span class="live"><b></b>Collecting</span>
  </div>
  <div class="hlab">Net flow · 24h · all tokens · ≥${minSol} SOL</div>
  <div style="display:flex;align-items:baseline">
    <span class="hero-num" style="color:${heroColor}">${netPos ? "+" : ""}${Math.round(totals.net)}</span>
    <span class="hsub">SOL ${netPos ? "accumulated" : "distributed"}</span>
  </div>
  <div class="pulsewrap"><canvas id="pulse" style="width:100%;height:80px" role="img" aria-label="24h cumulative net whale flow"></canvas></div>
</div>

<div class="cards">
  <div class="card"><div class="clab">Whales</div><div class="cnum">${totals.whales}</div><div class="csub">${totals.trades} trades</div></div>
  <div class="card"><div class="clab">Buys</div><div class="cnum pos">${flows.filter(f=>f.buy_sol>0).length}</div><div class="csub">${Math.round(buySol)} SOL in</div></div>
  <div class="card"><div class="clab">Sells</div><div class="cnum neg">${flows.filter(f=>f.sell_sol>0).length}</div><div class="csub">${Math.round(sellSol)} SOL out</div></div>
</div>

<div class="panel">
  <div class="phead"><span>By token</span><span style="color:#c4c4ca">sell ◂ ▸ buy</span></div>
  ${flows.length ? flowRows : `<div class="empty">No whale trades yet. Once Helius fires, flows appear here.</div>`}
</div>

<div class="disp">
  <div class="phead"><span>Analyst dispatch · every 6h</span></div>
  ${verdict ? `<div class="dtxt">${escapeHtml(verdict.summary)}</div>` : `<div class="empty">First dispatch after the next 6-hour run (00/06/12/18 UTC).</div>`}
</div>

<div class="panel">
  <div class="phead"><span>Recent whale trades</span></div>
  ${recent.length ? recentRows : `<div class="empty">Nothing yet.</div>`}
</div>

<script>
(function(){
  var S=${JSON.stringify(series)}, COL="${heroColor}";
  function rgba(a){var h=COL.substring(1);var r=parseInt(h.substr(0,2),16),g=parseInt(h.substr(2,2),16),b=parseInt(h.substr(4,2),16);return "rgba("+r+","+g+","+b+","+a+")";}
  var cv=document.getElementById('pulse');
  var dpr=Math.min(window.devicePixelRatio||1,2), W=cv.clientWidth||700, H=80;
  cv.width=W*dpr; cv.height=H*dpr; var ctx=cv.getContext('2d'); ctx.scale(dpr,dpr);
  var n=S.length, lo=Math.min(0,Math.min.apply(null,S)), hi=Math.max(0,Math.max.apply(null,S));
  var span=(hi-lo)||1, gap=6, dot=1.6, base=(hi/span)*(H-16)+8;
  for(var x=0;x<W;x+=gap){
    var fi=(x/W)*(n-1), i0=Math.floor(fi), i1=Math.min(i0+1,n-1), f=fi-i0;
    var v=S[i0]+(S[i1]-S[i0])*f;
    var yv=((hi-v)/span)*(H-16)+8;
    var y0=Math.min(base,yv), y1=Math.max(base,yv);
    for(var y=y1;y>=y0;y-=gap){
      var head=Math.abs(y-(v<0?y1:y0))<gap;
      ctx.fillStyle=head?COL:(x>W*0.7?rgba(0.5):rgba(0.22));
      ctx.beginPath(); ctx.arc(x,y,head?dot+0.6:dot,0,7); ctx.fill();
    }
  }
})();
setTimeout(function(){location.reload();},60000);
</script>
</body></html>`;

  return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
}

// ============================================================ HELPERS ======

const short = (s) => (s && s.length > 12 ? s.slice(0, 4) + "…" + s.slice(-4) : s || "");
const json = (o) => new Response(JSON.stringify(o, null, 2), { headers: { "content-type": "application/json" } });
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
