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
 *
 * USD pricing and token symbols come from Jupiter's free public API
 * (lite-api.jup.ag — no key or signup needed). Live market stats (price
 * change, market cap, liquidity, volume) come from DexScreener's free
 * public API. All three are best-effort: if a lookup fails, the affected
 * figures are just left blank instead of breaking the page.
 *
 * The dashboard supports a ?window= query param (1h, 6h, 24h, 7d) that
 * controls every stat on the page, e.g. /?window=6h.
 */

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_PRICE_URL = "https://lite-api.jup.ag/price/v3";
const JUPITER_TOKEN_URL = "https://lite-api.jup.ag/tokens/v2/search";
const DEXSCREENER_URL = "https://api.dexscreener.com/tokens/v1/solana";
const TOKEN_META_TTL = 7 * 86400;   // refresh cached symbols weekly
const MARKET_CACHE_TTL = 90;        // refresh cached market stats every 90s

const WINDOWS = { "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800 };
const WINDOW_LABELS = { "1h": "1H", "6h": "6H", "24h": "24H", "7d": "7D" };
const parseWindow = (url) => (WINDOWS[url.searchParams.get("window")] ? url.searchParams.get("window") : "24h");
const RANK_COLORS = ["#d4af37", "#a8a8b0", "#c98a4b"]; // gold / silver / bronze accents for the top 3 rows

export default {
  // ---------------------------------------------------------------- HTTP ----
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, url, env);
    }
    if (url.pathname === "/api/flows") {
      const window = parseWindow(url);
      const data = await getFlows(env, WINDOWS[window]);
      return json({ window, ...data });
    }
    if (url.pathname === "/") {
      return dashboard(env, parseWindow(url));
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

  const whales = [];
  for (const tx of txs) {
    const t = parseSwap(tx);
    if (!t) continue;                 // not a swap we understand
    if (t.sol_amount < minSol) continue; // too small — not a whale
    whales.push(t);
  }

  let stored = 0;
  if (whales.length) {
    const [solPrice] = await Promise.all([
      getSolPriceUsd(),
      resolveTokenMeta(env, whales.map((t) => t.mint)), // warms token_meta for the dashboard
    ]);

    for (const t of whales) {
      const usdAmount = solPrice != null ? t.sol_amount * solPrice : null;
      try {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO trades
           (signature, ts, wallet, mint, side, sol_amount, usd_amount, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(t.signature, t.ts, t.wallet, t.mint, t.side, t.sol_amount, usdAmount, now)
          .run();
        stored++;
      } catch (e) {
        console.log("insert error", e.message);
      }
    }
  }
  return json({ ok: true, received: txs.length, stored });
}

// ============================================================ JUPITER ======

/** Current SOL/USD price via Jupiter's Price API, or null if unavailable. */
async function getSolPriceUsd() {
  try {
    const res = await fetch(`${JUPITER_PRICE_URL}?ids=${SOL_MINT}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const price = data?.[SOL_MINT]?.usdPrice;
    return typeof price === "number" ? price : null;
  } catch (e) {
    console.log("jupiter price error", e.message);
    return null;
  }
}

/**
 * Resolve mint addresses to {symbol, name} via a local D1 cache backed by
 * Jupiter's Token API. Returns a map keyed by mint; entries are omitted
 * when neither the cache nor Jupiter has data for that mint.
 */
async function resolveTokenMeta(env, mints) {
  const unique = [...new Set(mints)];
  if (!unique.length) return {};

  const now = Math.floor(Date.now() / 1000);
  const placeholders = unique.map(() => "?").join(",");
  const cached = await env.DB.prepare(
    `SELECT mint, symbol, name, updated_at FROM token_meta WHERE mint IN (${placeholders})`
  )
    .bind(...unique)
    .all();

  const cachedByMint = {};
  (cached.results || []).forEach((r) => (cachedByMint[r.mint] = r));

  const meta = {};
  const stale = [];
  for (const mint of unique) {
    const c = cachedByMint[mint];
    if (c && now - c.updated_at < TOKEN_META_TTL) {
      meta[mint] = { symbol: c.symbol, name: c.name };
    } else {
      stale.push(mint);
    }
  }

  if (stale.length) {
    try {
      const res = await fetch(`${JUPITER_TOKEN_URL}?query=${stale.join(",")}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const list = await res.json();
        for (const tok of Array.isArray(list) ? list : []) {
          if (!tok?.id) continue;
          meta[tok.id] = { symbol: tok.symbol || null, name: tok.name || null };
          await env.DB.prepare(
            `INSERT INTO token_meta (mint, symbol, name, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(mint) DO UPDATE SET symbol=excluded.symbol, name=excluded.name, updated_at=excluded.updated_at`
          )
            .bind(tok.id, tok.symbol || null, tok.name || null, now)
            .run();
        }
      }
    } catch (e) {
      console.log("jupiter token meta error", e.message);
    }
    // Jupiter may not return every requested mint (unlisted/new tokens) —
    // fall back to whatever we had cached for those, even if stale.
    for (const mint of stale) {
      if (!meta[mint] && cachedByMint[mint]) {
        meta[mint] = { symbol: cachedByMint[mint].symbol, name: cachedByMint[mint].name };
      }
    }
  }

  return meta;
}

/**
 * Live market stats (price, 24h change, market cap, liquidity, volume)
 * per mint via a local D1 cache backed by DexScreener. A mint can have
 * several pools; the deepest-liquidity pair is used. Returns a map keyed
 * by mint; entries are omitted when neither the cache nor DexScreener has
 * data for that mint (e.g. a token with no indexed pair yet).
 */
async function getMarketData(env, mints) {
  const unique = [...new Set(mints)];
  if (!unique.length) return {};

  const now = Math.floor(Date.now() / 1000);
  const placeholders = unique.map(() => "?").join(",");
  const cached = await env.DB.prepare(
    `SELECT * FROM market_cache WHERE mint IN (${placeholders})`
  )
    .bind(...unique)
    .all();

  const cachedByMint = {};
  (cached.results || []).forEach((r) => (cachedByMint[r.mint] = r));

  const market = {};
  const stale = [];
  for (const mint of unique) {
    const c = cachedByMint[mint];
    if (c && now - c.updated_at < MARKET_CACHE_TTL) {
      market[mint] = c;
    } else {
      stale.push(mint);
    }
  }

  if (stale.length) {
    try {
      const res = await fetch(`${DEXSCREENER_URL}/${stale.join(",")}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const pairs = await res.json();
        const bestByMint = {};
        for (const p of Array.isArray(pairs) ? pairs : []) {
          const mint = p?.baseToken?.address;
          if (!mint || !stale.includes(mint)) continue;
          const liq = p.liquidity?.usd || 0;
          if (!bestByMint[mint] || liq > (bestByMint[mint].liquidity?.usd || 0)) {
            bestByMint[mint] = p;
          }
        }
        for (const mint of Object.keys(bestByMint)) {
          const p = bestByMint[mint];
          const row = {
            mint,
            price_usd: p.priceUsd != null ? Number(p.priceUsd) : null,
            price_change_24h: p.priceChange?.h24 ?? null,
            liquidity_usd: p.liquidity?.usd ?? null,
            market_cap: p.marketCap ?? p.fdv ?? null,
            volume_1h: p.volume?.h1 ?? null,
            volume_6h: p.volume?.h6 ?? null,
            volume_24h: p.volume?.h24 ?? null,
            updated_at: now,
          };
          market[mint] = row;
          await env.DB.prepare(
            `INSERT INTO market_cache
             (mint, price_usd, price_change_24h, liquidity_usd, market_cap, volume_1h, volume_6h, volume_24h, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(mint) DO UPDATE SET
               price_usd=excluded.price_usd, price_change_24h=excluded.price_change_24h,
               liquidity_usd=excluded.liquidity_usd, market_cap=excluded.market_cap,
               volume_1h=excluded.volume_1h, volume_6h=excluded.volume_6h, volume_24h=excluded.volume_24h,
               updated_at=excluded.updated_at`
          )
            .bind(
              row.mint, row.price_usd, row.price_change_24h, row.liquidity_usd,
              row.market_cap, row.volume_1h, row.volume_6h, row.volume_24h, now
            )
            .run();
        }
      }
    } catch (e) {
      console.log("dexscreener error", e.message);
    }
    // DexScreener may not have an indexed pair for every mint yet — fall
    // back to whatever we had cached for those, even if stale.
    for (const mint of stale) {
      if (!market[mint] && cachedByMint[mint]) market[mint] = cachedByMint[mint];
    }
  }

  return market;
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

async function getFlows(env, windowSeconds = WINDOWS["24h"]) {
  const windowStart = Math.floor(Date.now() / 1000) - windowSeconds;
  const bucketSeconds = Math.max(60, Math.floor(windowSeconds / 24)); // always ~24 buckets for the pulse chart

  const flows = await env.DB.prepare(
    `SELECT t.mint, tm.symbol AS symbol,
            SUM(CASE WHEN side='BUY'  THEN sol_amount ELSE 0 END) AS buy_sol,
            SUM(CASE WHEN side='SELL' THEN sol_amount ELSE 0 END) AS sell_sol,
            SUM(CASE WHEN side='BUY'  THEN usd_amount ELSE 0 END) AS buy_usd,
            SUM(CASE WHEN side='SELL' THEN usd_amount ELSE 0 END) AS sell_usd,
            COUNT(*)                       AS trades,
            COUNT(DISTINCT wallet)         AS whales
     FROM trades t
     LEFT JOIN token_meta tm ON tm.mint = t.mint
     WHERE ts >= ?
     GROUP BY t.mint
     ORDER BY (buy_sol - sell_sol) DESC`
  ).bind(windowStart).all();

  const recent = await env.DB.prepare(
    `SELECT t.ts, t.wallet, t.mint, tm.symbol AS symbol, t.side, t.sol_amount, t.usd_amount
     FROM trades t
     LEFT JOIN token_meta tm ON tm.mint = t.mint
     ORDER BY t.ts DESC LIMIT 30`
  ).all();

  const verdict = await env.DB.prepare(
    `SELECT created_at, summary FROM verdicts ORDER BY id DESC LIMIT 1`
  ).first();

  // bucketed net flow across the window, for the pulse chart (~24 buckets)
  const buckets = await env.DB.prepare(
    `SELECT CAST(ts/? AS INTEGER) AS bucket,
            SUM(CASE WHEN side='BUY' THEN sol_amount ELSE -sol_amount END) AS net
     FROM trades WHERE ts >= ?
     GROUP BY bucket ORDER BY bucket`
  ).bind(bucketSeconds, windowStart).all();

  const totals = flows.results
    ? flows.results.reduce(
        (a, f) => ({
          net: a.net + (f.buy_sol - f.sell_sol),
          netUsd: a.netUsd + ((f.buy_usd || 0) - (f.sell_usd || 0)),
          whales: a.whales + f.whales,
          trades: a.trades + f.trades,
        }),
        { net: 0, netUsd: 0, whales: 0, trades: 0 }
      )
    : { net: 0, netUsd: 0, whales: 0, trades: 0 };

  return {
    flows: flows.results || [],
    recent: recent.results || [],
    verdict,
    buckets: buckets.results || [],
    bucketSeconds,
    totals,
  };
}

// ============================================================ ANALYST ======

async function runAnalyst(env) {
  const { flows } = await getFlows(env, WINDOWS["24h"]);
  if (!flows.length) return;

  const lines = flows.map((f) => {
    const usdNote =
      f.buy_usd || f.sell_usd
        ? ` (≈$${fmtUsd(f.buy_usd)} bought / $${fmtUsd(f.sell_usd)} sold)`
        : "";
    return (
      `${tokenLabel(f)}: buys ${f.buy_sol.toFixed(1)} SOL, sells ${f.sell_sol.toFixed(1)} SOL${usdNote}, ` +
      `net ${(f.buy_sol - f.sell_sol).toFixed(1)} SOL across ${f.trades} trades by ${f.whales} unique whales`
    );
  });

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

async function dashboard(env, window) {
  let data;
  try {
    data = await getFlows(env, WINDOWS[window]);
  } catch (e) {
    return new Response(
      "Database not ready. Create the D1 database, paste schema.sql into its console, " +
        "and make sure wrangler.toml has your database_id.\n\n" + e.message,
      { status: 500 }
    );
  }

  const { flows, recent, verdict, buckets, bucketSeconds, totals } = data;
  const minSol = env.MIN_TRADE_SOL || 25;
  const maxFlow = Math.max(1, ...flows.map((f) => Math.max(f.buy_sol, f.sell_sol)));
  let market = {};
  try {
    market = await getMarketData(env, flows.map((f) => f.mint));
  } catch (e) {
    // market_cache may not exist yet on an un-migrated database — market
    // data is best-effort, so degrade to "no stats" instead of a 500.
    console.log("market data error", e.message);
  }
  const dexVolField = window === "1h" ? "volume_1h" : window === "6h" ? "volume_6h" : "volume_24h";

  const netPos = totals.net >= 0;
  const heroColor = netPos ? "#12b886" : "#ff5a4d";

  let buySol = 0, sellSol = 0, buyUsd = 0, sellUsd = 0;
  flows.forEach((f) => {
    buySol += f.buy_sol; sellSol += f.sell_sol;
    buyUsd += f.buy_usd || 0; sellUsd += f.sell_usd || 0;
  });

  // cumulative-net series across the window for the dot pulse (~24 points)
  const nowBucket = Math.floor(Date.now() / 1000 / bucketSeconds);
  const byBucket = {};
  buckets.forEach((b) => (byBucket[b.bucket] = b.net));
  const series = [];
  let cum = 0;
  for (let i = 23; i >= 0; i--) {
    cum += byBucket[nowBucket - i] || 0;
    series.push(Math.round(cum * 10) / 10);
  }

  const flowRows = flows
    .map((f, i) => {
      const net = f.buy_sol - f.sell_sol;
      const netUsd = (f.buy_usd || 0) - (f.sell_usd || 0);
      const pos = net >= 0;
      const sw = (f.sell_sol / maxFlow) * 50;
      const bw = (f.buy_sol / maxFlow) * 50;

      const m = market[f.mint] || {};
      const chg = m.price_change_24h;
      const dexVol = m[dexVolField];
      const whaleUsd = (f.buy_usd || 0) + (f.sell_usd || 0);
      const dominance = window !== "7d" && dexVol ? Math.min(100, (whaleUsd / dexVol) * 100) : null;
      const metaLine = [
        m.market_cap ? `MC $${fmtUsd(m.market_cap)}` : "",
        m.liquidity_usd ? `LP $${fmtUsd(m.liquidity_usd)}` : "",
      ].filter(Boolean).join(" · ");

      return `<div class="frow"${i === 0 ? ' style="border-top:none"' : ""}>
        <div class="frow-head">
          <span class="rank"${i < 3 ? ` style="color:${RANK_COLORS[i]}"` : ""}>#${i + 1}</span>
          <a class="sym" href="https://gmgn.ai/sol/token/${f.mint}" target="_blank">${escapeHtml(tokenLabel(f))}</a>
          ${chg != null ? `<span class="chg ${chg >= 0 ? "pos" : "neg"}">${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%</span>` : ""}
          <span class="meta">${metaLine}</span>
        </div>
        <div class="frow-body">
          <span class="axis">
            <span class="lft"><span class="sell" style="width:${sw}%"></span></span>
            <span class="cen"></span>
            <span class="rgt"><span class="buy" style="width:${bw}%"></span></span>
          </span>
          <span class="netcol">
            <span class="net ${pos ? "pos" : "neg"}">${pos ? "+" : ""}${net.toFixed(1)}</span>
            ${netUsd ? `<span class="netusd">${netUsd >= 0 ? "+" : "-"}$${fmtUsd(Math.abs(netUsd))}</span>` : ""}
          </span>
        </div>
        ${dominance != null ? `<div class="dom" title="Whale-sized volume as a share of ${WINDOW_LABELS[window]} DEX volume"><b style="width:${dominance}%"></b><span class="domlbl">${dominance.toFixed(0)}% whale-dominated</span></div>` : ""}
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
        <span class="tsol">${r.sol_amount.toFixed(1)} SOL${r.usd_amount != null ? `<br><span class="tusd">$${fmtUsd(r.usd_amount)}</span>` : ""}</span>
        <span class="tsym">${escapeHtml(tokenLabel(r))}</span>
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
  .tf{display:flex;gap:4px;margin-bottom:10px}
  .tf a{font-size:11px;font-weight:600;color:#8a8a90;padding:4px 10px;border-radius:7px;text-decoration:none;background:rgba(255,255,255,.04)}
  .tf a.tfa{background:#fff;color:var(--ink)}
  .hlab{font-size:12px;color:#6b6b70;margin-bottom:2px}
  .hero-num{font-size:56px;font-weight:600;letter-spacing:-0.03em;line-height:1}
  .hsub{font-size:15px;color:#6b6b70;margin-left:10px;font-weight:400}
  .herousd{font-size:13px;color:#6b6b70;margin-top:2px}
  .pulsewrap{position:relative;height:80px;margin:6px -6px -2px}
  .cards{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px}
  .card{background:var(--card);border-radius:14px;padding:14px 16px}
  .clab{font-size:11px;color:var(--mut);margin-bottom:8px}
  .cnum{font-size:26px;font-weight:600;letter-spacing:-0.02em}
  .csub{font-size:11px;color:var(--mut);margin-top:2px}
  .panel{background:var(--card);border-radius:14px;padding:16px 18px;margin-bottom:12px}
  .phead{font-size:12px;color:var(--mut);margin-bottom:12px;display:flex;justify-content:space-between}
  .frow{padding:10px 0;border-top:0.5px solid var(--line)}
  .frow-head{display:flex;align-items:center;gap:7px;margin-bottom:6px}
  .rank{font-size:11px;font-weight:700;color:var(--mut);flex:none;width:20px}
  .sym{font-size:13px;font-weight:500;color:var(--ink);text-decoration:none;flex:none}
  .chg{font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;flex:none;font-variant-numeric:tabular-nums}
  .chg.pos{background:rgba(18,184,134,.12);color:var(--teal)}
  .chg.neg{background:rgba(255,90,77,.12);color:var(--coral)}
  .meta{margin-left:auto;font-size:10px;color:var(--mut);white-space:nowrap;font-variant-numeric:tabular-nums}
  .frow-body{display:flex;align-items:center;gap:12px}
  .axis{flex:1;display:flex;align-items:center;height:14px}
  .lft{flex:1;display:flex;justify-content:flex-end}.rgt{flex:1}
  .cen{width:1px;height:16px;background:#e0e0e4}
  .sell{height:8px;background:var(--coral);border-radius:4px 0 0 4px}
  .buy{display:block;height:8px;background:var(--teal);border-radius:0 4px 4px 0}
  .netcol{display:flex;flex-direction:column;align-items:flex-end;line-height:1.25;flex:none;width:84px}
  .net{text-align:right;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
  .netusd{font-size:10px;color:var(--mut);font-variant-numeric:tabular-nums}
  .pos{color:var(--teal)}.neg{color:var(--coral)}
  .dom{position:relative;height:3px;background:var(--line);border-radius:2px;margin-top:8px}
  .dom b{display:block;height:100%;background:#6a5acd;border-radius:2px}
  .domlbl{position:absolute;right:0;top:5px;font-size:9px;color:var(--mut)}
  .disp{background:var(--card);border-radius:14px;padding:16px 18px;margin-bottom:12px}
  .dtxt{font-size:14px;line-height:1.55;color:var(--ink)}
  .trow{display:grid;grid-template-columns:46px 42px 86px 1fr 82px;align-items:center;gap:8px;padding:8px 0;border-top:0.5px solid var(--line);font-size:12px}
  .tm{color:var(--mut);font-variant-numeric:tabular-nums}
  .side{font-weight:600}.tsol{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
  .tusd{font-weight:400;color:var(--mut);font-size:10px}
  .tsym{color:var(--mut);padding-left:8px}
  .tw{text-align:right;color:var(--mut2);text-decoration:none}
  .empty{color:var(--mut);padding:10px 0;font-size:13px}
</style></head><body>

<div class="hero">
  <div class="htop">
    <div><span class="brand">Trnchr</span><span class="htag">whale flow</span></div>
    <span class="live"><b></b>Collecting</span>
  </div>
  <div class="tf">
    ${Object.keys(WINDOWS).map((w) => `<a href="/?window=${w}"${w === window ? ' class="tfa"' : ""}>${WINDOW_LABELS[w]}</a>`).join("")}
  </div>
  <div class="hlab">Net flow · ${WINDOW_LABELS[window]} · all tokens · ≥${minSol} SOL</div>
  <div style="display:flex;align-items:baseline">
    <span class="hero-num" style="color:${heroColor}">${netPos ? "+" : ""}${Math.round(totals.net)}</span>
    <span class="hsub">SOL ${netPos ? "accumulated" : "distributed"}</span>
  </div>
  ${totals.netUsd ? `<div class="herousd">≈ ${netPos ? "+" : "-"}$${fmtUsd(Math.abs(totals.netUsd))} USD</div>` : ""}
  <div class="pulsewrap"><canvas id="pulse" style="width:100%;height:80px" role="img" aria-label="${WINDOW_LABELS[window]} cumulative net whale flow"></canvas></div>
</div>

<div class="cards">
  <div class="card"><div class="clab">Whales</div><div class="cnum">${totals.whales}</div><div class="csub">${totals.trades} trades</div></div>
  <div class="card"><div class="clab">Buys</div><div class="cnum pos">${flows.filter(f=>f.buy_sol>0).length}</div><div class="csub">${Math.round(buySol)} SOL${buyUsd ? " · $" + fmtUsd(buyUsd) : ""}</div></div>
  <div class="card"><div class="clab">Sells</div><div class="cnum neg">${flows.filter(f=>f.sell_sol>0).length}</div><div class="csub">${Math.round(sellSol)} SOL${sellUsd ? " · $" + fmtUsd(sellUsd) : ""}</div></div>
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

/** "$BONK" if we have a Jupiter symbol for this row's mint, else a shortened mint address. */
const tokenLabel = (row) => "$" + (row.symbol || short(row.mint));

/** Compact USD figure: 1.2M, 4.5k, or a plain integer. */
function fmtUsd(n) {
  if (n == null) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toFixed(0);
}
