/**
 * WHALE RADAR — a one-file Cloudflare Worker.
 *
 * What it does:
 *   1. Receives swap events from Helius webhooks  (POST /webhook?key=...)
 *   2. Stores every trade >= DUST_FLOOR_SOL in D1 (a low per-trade floor —
 *      NOT the whale threshold; see below)
 *   3. Shows accumulated whale flows at your worker URL  (GET /)
 *   4. Every 6 hours, an "analyst" cron summarises the last 24h
 *      (uses the Claude API if ANTHROPIC_API_KEY is set, otherwise
 *       writes a plain computed summary)
 *   5. Wallet analyzer: paste any address into the search box on the
 *      dashboard (or GET /wallet?address=...) for a one-page summary —
 *      its trade history in your D1, its most-recent-funder chain, its
 *      earliest funder + rough age, current SOL balance, and whether it
 *      shares a funder with any other wallet you've already tracked (the
 *      same signal the "Wallet clusters" panel uses, just on demand for
 *      one address instead of aggregated across all whale flow). The D1
 *      section works with no setup; funding/balance/age need HELIUS_API_KEY.
 *   6. TEMPORARY: GET /debug/funding-origin?key=WEBHOOK_SECRET&wallet=...
 *      looks up a wallet's earliest funder, for validating a coordinated-
 *      wallet-cluster detection layer against known cases. Delete once done.
 *
 * "Whale" is a CUMULATIVE, QUERY-TIME concept, not a per-trade filter:
 * an "actor" (a wallet, or a cluster of wallets sharing a funder — see
 * wallet_funding below) qualifies as a whale for a token if its total
 * volume within the selected time window is >= MIN_TRADE_SOL. This is
 * deliberate: filtering single trades by size at ingestion is trivially
 * bypassed by splitting one big buy into many small ones. Storing
 * everything above a low dust floor and aggregating per actor at query
 * time catches that split-transaction pattern.
 *
 * Settings (set in Cloudflare dashboard -> your worker -> Settings -> Variables):
 *   WEBHOOK_SECRET      required — any password you invent; must match the ?key= in your Helius webhook URL
 *   MIN_TRADE_SOL       optional — cumulative SOL an actor must move (buys+sells) within the selected window to count as a whale (default 25)
 *   DUST_FLOOR_SOL      optional — minimum SINGLE trade size to even bother storing (default 1); lower = catches finer-grained splitting, costs more D1 writes
 *   ANTHROPIC_API_KEY   optional — enables the AI analyst
 *   HELIUS_API_KEY      optional — enables wallet-funding lookups, which cluster whale activity split across multiple wallets funded by the same source
 *   FUNDING_MAX_HOPS    optional — how many funding edges to trace back per wallet (default 2: wallet -> funder -> funder's funder); only matters with HELIUS_API_KEY set
 *   FUNDING_HUB_FANOUT  optional — an address that has funded more than this many distinct wallets is treated as a hub (CEX/router), never clustered through (default 3)
 *   HELIUS_WEBHOOK_ID   optional — your Helius webhook's ID (from its dashboard page, NOT the webhook secret). Setting this turns on auto-tracking: every 2h, the Worker fetches trending Solana tokens from DexScreener and rewrites your Helius webhook's watched addresses to match. Manual edits to the watchlist in the Helius dashboard will be overwritten on the next sync — see PINNED_TOKENS to keep specific tokens always-watched.
 *   AUTO_TRACK_TOP_N    optional — how many trending tokens to auto-track (default 10)
 *   PINNED_TOKENS       optional — comma-separated mint addresses always kept in the watchlist alongside the trending ones
 *
 * USD pricing and token symbols come from Jupiter's free public API
 * (lite-api.jup.ag — no key or signup needed). Live market stats (price
 * change, market cap, liquidity, volume) come from DexScreener's free
 * public API. Wallet-funding lookups come from Helius's Enhanced
 * Transactions API (needs HELIUS_API_KEY, a different credential than
 * your webhook secret — same free Helius account). All of these are
 * best-effort: if a lookup fails, the affected figures are just left
 * blank instead of breaking the page.
 *
 * The dashboard supports a ?window= query param (1h, 6h, 24h, 7d) that
 * controls every stat on the page, e.g. /?window=6h.
 */

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_PRICE_URL = "https://lite-api.jup.ag/price/v3";
const JUPITER_TOKEN_URL = "https://lite-api.jup.ag/tokens/v2/search";
const DEXSCREENER_URL = "https://api.dexscreener.com/tokens/v1/solana";
const DEXSCREENER_TRENDING_URL = "https://api.dexscreener.com/metas/trending/v1";
const HELIUS_API_URL = "https://api.helius.xyz/v0/addresses";
const HELIUS_WEBHOOK_URL = "https://api.helius.xyz/v0/webhooks";
const HELIUS_RPC_URL = "https://mainnet.helius-rpc.com";
const HELIUS_TX_URL = "https://api.helius.xyz/v0/transactions";
const FUNDING_ORIGIN_MAX_PAGES = 10; // cap signature pagination at 10k txs — a wallet needing more than that isn't a useful funding-origin subject anyway
const TOKEN_META_TTL = 7 * 86400;      // refresh cached symbols weekly
const MARKET_CACHE_TTL = 90;           // refresh cached market stats every 90s
const FUNDING_CACHE_TTL = 14 * 86400;  // recheck a wallet's funding source every 2 weeks
const MIN_TRANSFER_LAMPORTS = 0.05 * 1e9; // ignore dust/fee-relay transfers when looking for a funder
const DEFAULT_FUNDING_MAX_HOPS = 2;  // wallet -> funder -> funder's funder
const DEFAULT_HUB_FANOUT_CAP = 3;    // an address funding more than this many distinct wallets is a hub (CEX/router), not a personal funder
const DEFAULT_AUTO_TRACK_TOP_N = 10;
const MAX_WATCHLIST_SIZE = 50;       // defensive cap regardless of config, independent of any Helius-side limit
const ANALYST_CRON = "0 */6 * * *";
const TRENDING_SYNC_CRON = "0 */2 * * *";

// Solana addresses are base58-encoded ed25519 pubkeys: 32-44 chars, and the
// base58 alphabet excludes 0/O/I/l (ambiguous glyphs) — so this also rejects
// things like Ethereum's 0x-prefixed hex addresses, which a length-only
// check would let through.
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
    if (url.pathname === "/debug/funding-origin") {
      // Temporary: validates the earliest-funder lookup against known
      // coordinated-wallet cases before it becomes a real detection layer.
      // Gated behind the same secret as the webhook so it can't be used to
      // burn your Helius quota by anyone who finds the URL. Delete this
      // route once that validation is done.
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const wallet = url.searchParams.get("wallet");
      if (!wallet) return json({ error: "pass ?wallet=<address>" }, 400);
      if (!env.HELIUS_API_KEY) return json({ error: "HELIUS_API_KEY not set" }, 400);
      return json(await findFundingOrigin(env, wallet));
    }
    if (url.pathname === "/wallet") {
      return walletPage(env, url.searchParams.get("address"));
    }
    if (url.pathname === "/") {
      return dashboard(env, parseWindow(url), url.searchParams.get("partial") === "1");
    }
    return new Response("Not found", { status: 404 });
  },

  // ---------------------------------------------------------------- CRON ----
  async scheduled(event, env, ctx) {
    if (event.cron === TRENDING_SYNC_CRON) {
      ctx.waitUntil(syncTrendingWatchlist(env));
    } else {
      ctx.waitUntil(runAnalyst(env));
    }
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
  const dustFloor = parseFloat(env.DUST_FLOOR_SOL || "1");
  const now = Math.floor(Date.now() / 1000);

  // Store every trade above the dust floor — NOT just ones that individually
  // clear the whale threshold. Whale status is computed at query time from
  // cumulative actor volume (see getFlows), so a single-trade size filter
  // here would just let split-transaction accumulation bypass detection.
  const candidates = [];
  for (const tx of txs) {
    const t = parseSwap(tx);
    if (!t) continue;                    // not a swap we understand
    if (t.sol_amount < dustFloor) continue; // too small to matter even split up
    candidates.push(t);
  }

  let stored = 0;
  if (candidates.length) {
    const [solPrice] = await Promise.all([
      getSolPriceUsd(),
      resolveTokenMeta(env, candidates.map((t) => t.mint)),   // warms token_meta for the dashboard
      resolveFundingSource(env, candidates.map((t) => t.wallet)), // warms wallet_funding for clustering
    ]);

    for (const t of candidates) {
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
  let cached;
  try {
    cached = await env.DB.prepare(
      `SELECT mint, symbol, name, updated_at FROM token_meta WHERE mint IN (${placeholders})`
    )
      .bind(...unique)
      .all();
  } catch (e) {
    console.log("token_meta read error", e.message); // e.g. migration not run yet — never let this block ingestion
    return {};
  }

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
 * Best-effort: for each wallet, find the most recent external SOL transfer
 * INTO it (a heuristic "funder"), via Helius's Enhanced Transactions API,
 * and cache it in wallet_funding. Then recurses onto the newly-discovered
 * funder addresses themselves (funder's funder, etc.), up to FUNDING_MAX_HOPS
 * total edges, so a whale that launders through an extra hop before
 * splitting into trading wallets still clusters correctly.
 *
 * Addresses that already show high fan-out (many distinct wallets funded —
 * see hubFanout) are never chased further: those are almost certainly a
 * CEX/router/aggregator address, not a personal funding wallet, and chasing
 * them would waste API calls and eventually merge unrelated whales who
 * simply share an exchange.
 *
 * This is a heuristic, not a full recursive funding graph: it only looks
 * at each wallet's most recent handful of transfers, and it will pick up
 * a DEX/router address as the "funder" if that's genuinely the most recent
 * SOL inflow (e.g. proceeds from a prior sell). Good enough to catch naive
 * sybil-wallet structuring; not a substitute for real chain-forensics
 * tooling. No-ops entirely if HELIUS_API_KEY isn't set.
 */
async function resolveFundingSource(env, wallets, hopsRemaining) {
  if (!env.HELIUS_API_KEY) return;
  if (hopsRemaining == null) {
    hopsRemaining = Math.max(1, parseInt(env.FUNDING_MAX_HOPS || String(DEFAULT_FUNDING_MAX_HOPS), 10));
  }
  if (hopsRemaining <= 0) return;

  const unique = [...new Set(wallets)];
  if (!unique.length) return;

  const now = Math.floor(Date.now() / 1000);
  const placeholders = unique.map(() => "?").join(",");
  let cached;
  try {
    cached = await env.DB.prepare(
      `SELECT wallet, checked_at FROM wallet_funding WHERE wallet IN (${placeholders})`
    )
      .bind(...unique)
      .all();
  } catch (e) {
    console.log("wallet_funding read error (migration not run yet?)", e.message);
    return; // never let this block trade ingestion
  }

  const checkedByWallet = {};
  (cached.results || []).forEach((r) => (checkedByWallet[r.wallet] = r.checked_at));
  const stale = unique.filter((w) => now - (checkedByWallet[w] || 0) >= FUNDING_CACHE_TTL);

  const discoveredFunders = [];
  for (const wallet of stale) {
    try {
      const res = await fetch(
        `${HELIUS_API_URL}/${wallet}/transactions?api-key=${env.HELIUS_API_KEY}&type=TRANSFER&limit=20`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (!res.ok) continue;
      const txs = await res.json();

      let fundedBy = null;
      for (const tx of Array.isArray(txs) ? txs : []) {
        for (const nt of tx.nativeTransfers || []) {
          if (nt.toUserAccount === wallet && nt.fromUserAccount !== wallet && nt.amount >= MIN_TRANSFER_LAMPORTS) {
            fundedBy = nt.fromUserAccount;
            break;
          }
        }
        if (fundedBy) break;
      }

      await env.DB.prepare(
        `INSERT INTO wallet_funding (wallet, funded_by, checked_at) VALUES (?, ?, ?)
         ON CONFLICT(wallet) DO UPDATE SET funded_by=excluded.funded_by, checked_at=excluded.checked_at`
      )
        .bind(wallet, fundedBy, now)
        .run();
      if (fundedBy) discoveredFunders.push(fundedBy);
    } catch (e) {
      console.log("helius funding lookup error", e.message);
    }
  }

  if (discoveredFunders.length && hopsRemaining > 1) {
    const chaseable = await filterOutHubs(env, discoveredFunders);
    if (chaseable.length) await resolveFundingSource(env, chaseable, hopsRemaining - 1);
  }
}

/** Drop addresses that already show hub-like fan-out (funded many distinct wallets) — not worth chasing further, and not safe to cluster through. */
async function filterOutHubs(env, addresses) {
  const cap = Math.max(1, parseInt(env.FUNDING_HUB_FANOUT || String(DEFAULT_HUB_FANOUT_CAP), 10));
  const unique = [...new Set(addresses)];
  if (!unique.length) return [];
  try {
    const placeholders = unique.map(() => "?").join(",");
    const res = await env.DB.prepare(
      `SELECT funded_by, COUNT(DISTINCT wallet) AS fanout
       FROM wallet_funding WHERE funded_by IN (${placeholders}) GROUP BY funded_by`
    )
      .bind(...unique)
      .all();
    const fanoutByAddr = {};
    (res.results || []).forEach((r) => (fanoutByAddr[r.funded_by] = r.fanout));
    return unique.filter((a) => (fanoutByAddr[a] || 0) <= cap);
  } catch (e) {
    console.log("hub fanout check error", e.message);
    return unique; // best-effort — still bounded by the hop count either way
  }
}

/**
 * Finds a wallet's EARLIEST incoming external SOL transfer — who originally
 * funded it — as opposed to resolveFundingSource() above, which tracks the
 * MOST RECENT funder for merging split-wallet whale volume into one actor.
 * "Earliest funder" is the signal for a different question: who set this
 * wallet up in the first place, which is what coordinated-insider-wallet
 * detection actually needs. Also returns oldest_block_time, a cheap proxy
 * for wallet age (no extra call — it's already on the signature we fetch).
 *
 * Used by both the /debug/funding-origin route (manual validation against
 * known cases) and analyzeWallet() (the /wallet analyzer page). Not cached —
 * every call re-walks signature history, so it's meant for on-demand,
 * one-off lookups, not bulk/background use.
 *
 * Neither Solana's RPC nor Helius's API has a "first transaction" call —
 * signature history only comes back newest-first. So this pages backwards
 * via getSignaturesForAddress until a page comes back short (the tail of
 * history), then pulls the parsed nativeTransfers for that oldest signature
 * via Helius's Enhanced Transaction API to read off the sender.
 */
async function findFundingOrigin(env, wallet) {
  let before;
  let sigs = [];
  let pages = 0;
  try {
    do {
      const params = before ? [wallet, { limit: 1000, before }] : [wallet, { limit: 1000 }];
      const res = await fetch(`${HELIUS_RPC_URL}/?api-key=${env.HELIUS_API_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { wallet, error: `rpc ${res.status}` };
      const data = await res.json();
      sigs = data.result || [];
      pages++;
      if (sigs.length) before = sigs[sigs.length - 1].signature;
    } while (sigs.length === 1000 && pages < FUNDING_ORIGIN_MAX_PAGES);
  } catch (e) {
    return { wallet, error: `rpc error: ${e.message}` };
  }

  if (!sigs.length) return { wallet, error: "no transaction history found" };
  const oldest = sigs[sigs.length - 1].signature;
  const oldestBlockTime = sigs[sigs.length - 1].blockTime ?? null;
  const truncated = pages >= FUNDING_ORIGIN_MAX_PAGES && sigs.length === 1000;

  try {
    const txRes = await fetch(`${HELIUS_TX_URL}?api-key=${env.HELIUS_API_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactions: [oldest] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!txRes.ok) return { wallet, oldest_signature: oldest, error: `tx fetch ${txRes.status}` };
    const [tx] = await txRes.json();
    const nativeTransfers = tx?.nativeTransfers || [];
    const funding = nativeTransfers.find((nt) => nt.toUserAccount === wallet && nt.fromUserAccount !== wallet);
    return {
      wallet,
      oldest_signature: oldest,
      oldest_block_time: oldestBlockTime, // unix seconds — proxy for wallet age when not truncated
      pages_scanned: pages,
      truncated, // true means we hit the page cap before finding the true first tx
      funded_by: funding?.fromUserAccount || null,
      funded_amount_sol: funding ? funding.amount / 1e9 : null,
      native_transfers: nativeTransfers,
    };
  } catch (e) {
    return { wallet, oldest_signature: oldest, error: `tx fetch error: ${e.message}` };
  }
}

/**
 * Full on-demand summary for a single wallet address, powering the /wallet
 * analyzer page. Combines:
 *  - this wallet's trade history in OUR OWN D1 (always available, free)
 *  - a same-DB cluster check: other wallets we've tracked that share this
 *    wallet's most-recent cached funder (free — D1 only)
 *  - the most-recent-funder chain, via resolveFundingSource (reuses its
 *    cache) — needs HELIUS_API_KEY
 *  - the earliest funder + a rough wallet-age signal, via findFundingOrigin
 *    — needs HELIUS_API_KEY
 *  - current SOL balance — needs HELIUS_API_KEY
 * The D1-only section always returns something useful even with no Helius
 * key configured; the on-chain sections are simply omitted in that case
 * rather than erroring.
 */
async function analyzeWallet(env, address) {
  const result = { address, heliusEnabled: !!env.HELIUS_API_KEY };

  try {
    const trades = await env.DB.prepare(
      `SELECT t.mint, tm.symbol, t.side, t.sol_amount, t.usd_amount, t.ts
       FROM trades t LEFT JOIN token_meta tm ON tm.mint = t.mint
       WHERE t.wallet = ? ORDER BY t.ts DESC LIMIT 50`
    ).bind(address).all();
    const rows = trades.results || [];
    result.trades = {
      rows,
      distinctTokens: new Set(rows.map((r) => r.mint)).size,
      buySol: rows.filter((r) => r.side === "BUY").reduce((a, r) => a + r.sol_amount, 0),
      sellSol: rows.filter((r) => r.side === "SELL").reduce((a, r) => a + r.sol_amount, 0),
    };
  } catch (e) {
    result.trades = { rows: [], distinctTokens: 0, buySol: 0, sellSol: 0 };
  }

  try {
    if (await tableExists(env, "wallet_funding")) {
      const own = await env.DB.prepare(`SELECT funded_by FROM wallet_funding WHERE wallet = ?`).bind(address).first();
      if (own?.funded_by) {
        const siblings = await env.DB.prepare(
          `SELECT wallet FROM wallet_funding WHERE funded_by = ? AND wallet != ?`
        ).bind(own.funded_by, address).all();
        result.cluster = { funder: own.funded_by, siblings: (siblings.results || []).map((r) => r.wallet) };
      } else {
        result.cluster = { funder: null, siblings: [] };
      }
    }
  } catch (e) {
    console.log("wallet cluster check error", e.message);
  }

  if (!env.HELIUS_API_KEY) return result;

  // most-recent-funder chain: trigger the normal lookup (cache-aware, walks
  // FUNDING_MAX_HOPS same as everywhere else) then read the resulting chain back
  await resolveFundingSource(env, [address]);
  const chain = [];
  let node = address;
  for (let i = 0; i < 5 && node; i++) {
    const row = await env.DB.prepare(`SELECT funded_by FROM wallet_funding WHERE wallet = ?`).bind(node).first();
    if (!row?.funded_by || chain.includes(row.funded_by) || row.funded_by === address) break;
    chain.push(row.funded_by);
    node = row.funded_by;
  }
  result.fundingChain = chain;

  result.origin = await findFundingOrigin(env, address);

  try {
    const res = await fetch(`${HELIUS_RPC_URL}/?api-key=${env.HELIUS_API_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      result.balanceSol = data?.result?.value != null ? data.result.value / 1e9 : null;
    }
  } catch (e) {
    console.log("balance lookup error", e.message);
  }

  return result;
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

// ============================================================ TRENDING =====

/**
 * Best-effort: fetch up to `limit` Solana token mints from DexScreener's
 * trending endpoint. The exact response shape isn't fully documented for
 * third-party use, so this parses defensively — several possible wrapper
 * keys and several possible per-item address fields — and returns an empty
 * list rather than throwing if the shape doesn't match what's expected.
 */
async function fetchTrendingMints(limit) {
  try {
    const res = await fetch(`${DEXSCREENER_TRENDING_URL}?chainId=solana`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.pairs)
      ? data.pairs
      : Array.isArray(data?.tokens)
      ? data.tokens
      : Array.isArray(data?.data)
      ? data.data
      : [];

    const mints = [];
    for (const item of list) {
      const mint = item?.tokenAddress || item?.address || item?.baseToken?.address || item?.mint;
      if (mint && !mints.includes(mint)) mints.push(mint);
      if (mints.length >= limit) break;
    }
    return mints;
  } catch (e) {
    console.log("dexscreener trending fetch error", e.message);
    return [];
  }
}

/**
 * Rewrites the Helius webhook's watched addresses to [PINNED_TOKENS,
 * ...top trending]. No-ops entirely unless HELIUS_API_KEY and
 * HELIUS_WEBHOOK_ID are both set. Fetches the webhook's current full
 * config first and PUTs it back with only accountAddresses changed, so
 * every other setting (transaction types, webhook type, auth header, …)
 * configured in the Helius dashboard is preserved untouched. Skips the
 * PUT entirely if the desired address set already matches — avoids
 * needless API calls and log noise on every sync tick.
 */
async function syncTrendingWatchlist(env) {
  if (!env.HELIUS_API_KEY || !env.HELIUS_WEBHOOK_ID) return;

  const topN = Math.max(
    1,
    Math.min(MAX_WATCHLIST_SIZE, parseInt(env.AUTO_TRACK_TOP_N || String(DEFAULT_AUTO_TRACK_TOP_N), 10))
  );
  const trending = await fetchTrendingMints(topN);
  if (!trending.length) {
    console.log("trending sync: no trending tokens fetched, skipping this cycle");
    return;
  }

  const pinned = (env.PINNED_TOKENS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const desired = [...new Set([...pinned, ...trending])].slice(0, MAX_WATCHLIST_SIZE);

  try {
    const getRes = await fetch(`${HELIUS_WEBHOOK_URL}/${env.HELIUS_WEBHOOK_ID}?api-key=${env.HELIUS_API_KEY}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!getRes.ok) {
      console.log("trending sync: failed to fetch current webhook config", getRes.status);
      return;
    }
    const current = await getRes.json();
    const currentAddresses = Array.isArray(current.accountAddresses) ? current.accountAddresses : [];

    const unchanged =
      currentAddresses.length === desired.length && currentAddresses.every((a) => desired.includes(a));
    if (unchanged) return;

    const putRes = await fetch(`${HELIUS_WEBHOOK_URL}/${env.HELIUS_WEBHOOK_ID}?api-key=${env.HELIUS_API_KEY}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...current, accountAddresses: desired }),
      signal: AbortSignal.timeout(6000),
    });
    if (!putRes.ok) {
      console.log("trending sync: failed to update webhook", putRes.status, await putRes.text());
      return;
    }
    console.log(`trending sync: watchlist updated to ${desired.length} addresses`);
  } catch (e) {
    console.log("trending sync error", e.message);
  }
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

/**
 * Shared CTE: maps every wallet active in the window to an "actor" and
 * qualifies actors whose cumulative volume clears MIN_TRADE_SOL as
 * whale_actors. Every query below joins through this so "whale" always
 * means cumulative-per-actor, never a single trade's size.
 *
 * Two variants, picked per-call by whether wallet_funding exists yet (so an
 * un-migrated database still gets correct, if unclustered, whale detection
 * instead of an error):
 *
 *   UNFUNDED — actor == wallet. Placeholders: [windowStart, windowStart, minWhaleSol].
 *
 *   FUNDED — actor == the wallet's funding-chain root, walked up to
 *   FUNDING_MAX_HOPS edges via a recursive CTE. Any node whose fan-out
 *   (COUNT DISTINCT wallets it has funded) exceeds FUNDING_HUB_FANOUT stops
 *   the chain right there instead of being used as a clustering root — an
 *   address that funded a dozen unrelated wallets is a CEX/router, not a
 *   sybil operator, and clustering through it would merge unrelated whales.
 *   Placeholders: [windowStart, maxHops, hubFanoutCap, windowStart, minWhaleSol].
 */
const ACTOR_TOTALS_CTE = `
  actor_totals AS (
    SELECT am.actor, t.mint,
           SUM(CASE WHEN t.side='BUY' THEN t.sol_amount ELSE 0 END) AS buy_sol,
           SUM(CASE WHEN t.side='SELL' THEN t.sol_amount ELSE 0 END) AS sell_sol,
           COUNT(DISTINCT t.wallet) AS wallet_count
    FROM trades t
    JOIN actor_map am ON am.wallet = t.wallet
    WHERE t.ts >= ?
    GROUP BY am.actor, t.mint
  ),
  whale_actors AS (
    SELECT actor, mint, wallet_count FROM actor_totals WHERE (buy_sol + sell_sol) >= ?
  )
`;
const WHALE_CTE_FUNDED = `
  WITH RECURSIVE
  funder_fanout AS (
    SELECT funded_by, COUNT(DISTINCT wallet) AS fanout
    FROM wallet_funding
    WHERE funded_by IS NOT NULL
    GROUP BY funded_by
  ),
  chain(origin, node, hop) AS (
    SELECT DISTINCT t.wallet, t.wallet, 0
    FROM trades t
    WHERE t.ts >= ?
    UNION ALL
    SELECT chain.origin, wf.funded_by, chain.hop + 1
    FROM chain
    JOIN wallet_funding wf ON wf.wallet = chain.node
    LEFT JOIN funder_fanout ff ON ff.funded_by = wf.funded_by
    WHERE chain.hop < ?
      AND wf.funded_by IS NOT NULL
      AND wf.funded_by != chain.node
      AND COALESCE(ff.fanout, 0) <= ?
  ),
  actor_map AS (
    SELECT c.origin AS wallet, c.node AS actor
    FROM chain c
    WHERE c.hop = (SELECT MAX(hop) FROM chain c2 WHERE c2.origin = c.origin)
  ),
  ${ACTOR_TOTALS_CTE}
`;
const WHALE_CTE_UNFUNDED = `
  WITH actor_map AS (
    SELECT DISTINCT t.wallet, t.wallet AS actor
    FROM trades t
    WHERE t.ts >= ?
  ),
  ${ACTOR_TOTALS_CTE}
`;

async function tableExists(env, name) {
  try {
    const row = await env.DB.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`
    )
      .bind(name)
      .first();
    return !!row;
  } catch {
    return false;
  }
}

async function getFlows(env, windowSeconds = WINDOWS["24h"]) {
  const windowStart = Math.floor(Date.now() / 1000) - windowSeconds;
  const bucketSeconds = Math.max(60, Math.floor(windowSeconds / 24)); // always ~24 buckets for the pulse chart
  const minWhaleSol = parseFloat(env.MIN_TRADE_SOL || "25");
  const hasFunding = await tableExists(env, "wallet_funding");
  const WHALE_CTE = hasFunding ? WHALE_CTE_FUNDED : WHALE_CTE_UNFUNDED;
  const cteArgs = hasFunding
    ? [
        windowStart,
        Math.max(1, parseInt(env.FUNDING_MAX_HOPS || String(DEFAULT_FUNDING_MAX_HOPS), 10)),
        Math.max(1, parseInt(env.FUNDING_HUB_FANOUT || String(DEFAULT_HUB_FANOUT_CAP), 10)),
        windowStart,
        minWhaleSol,
      ]
    : [windowStart, windowStart, minWhaleSol];

  const flows = await env.DB.prepare(
    WHALE_CTE +
      `SELECT t.mint, tm.symbol AS symbol,
              SUM(CASE WHEN t.side='BUY'  THEN t.sol_amount ELSE 0 END) AS buy_sol,
              SUM(CASE WHEN t.side='SELL' THEN t.sol_amount ELSE 0 END) AS sell_sol,
              SUM(CASE WHEN t.side='BUY'  THEN t.usd_amount ELSE 0 END) AS buy_usd,
              SUM(CASE WHEN t.side='SELL' THEN t.usd_amount ELSE 0 END) AS sell_usd,
              COUNT(*)                                                       AS trades,
              COUNT(DISTINCT t.wallet)                                       AS whales,
              COUNT(DISTINCT wa.actor)                                       AS actors,
              COUNT(DISTINCT CASE WHEN wa.wallet_count > 1 THEN wa.actor END) AS sybil_actors
       FROM trades t
       JOIN actor_map am ON am.wallet = t.wallet
       JOIN whale_actors wa ON wa.actor = am.actor AND wa.mint = t.mint
       LEFT JOIN token_meta tm ON tm.mint = t.mint
       WHERE t.ts >= ?
       GROUP BY t.mint
       ORDER BY (buy_sol - sell_sol) DESC`
  ).bind(...cteArgs, windowStart).all();

  const recent = await env.DB.prepare(
    WHALE_CTE +
      `SELECT t.signature, t.ts, t.wallet, t.mint, tm.symbol AS symbol, t.side, t.sol_amount, t.usd_amount, wa.wallet_count
       FROM trades t
       JOIN actor_map am ON am.wallet = t.wallet
       JOIN whale_actors wa ON wa.actor = am.actor AND wa.mint = t.mint
       LEFT JOIN token_meta tm ON tm.mint = t.mint
       WHERE t.ts >= ?
       ORDER BY t.ts DESC LIMIT 30`
  ).bind(...cteArgs, windowStart).all();

  const verdict = await env.DB.prepare(
    `SELECT created_at, summary FROM verdicts ORDER BY id DESC LIMIT 1`
  ).first();

  // bucketed net flow across the window, for the pulse chart (~24 buckets)
  const buckets = await env.DB.prepare(
    WHALE_CTE +
      `SELECT CAST(t.ts/? AS INTEGER) AS bucket,
              SUM(CASE WHEN t.side='BUY' THEN t.sol_amount ELSE -t.sol_amount END) AS net
       FROM trades t
       JOIN actor_map am ON am.wallet = t.wallet
       JOIN whale_actors wa ON wa.actor = am.actor AND wa.mint = t.mint
       WHERE t.ts >= ?
       GROUP BY bucket ORDER BY bucket`
  ).bind(...cteArgs, bucketSeconds, windowStart).all();

  // same bucketing, but per-token — powers each row's sparkline + spike badge
  const tokenBuckets = await env.DB.prepare(
    WHALE_CTE +
      `SELECT t.mint, CAST(t.ts/? AS INTEGER) AS bucket,
              SUM(CASE WHEN t.side='BUY' THEN t.sol_amount ELSE -t.sol_amount END) AS net
       FROM trades t
       JOIN actor_map am ON am.wallet = t.wallet
       JOIN whale_actors wa ON wa.actor = am.actor AND wa.mint = t.mint
       WHERE t.ts >= ?
       GROUP BY t.mint, bucket ORDER BY t.mint, bucket`
  ).bind(...cteArgs, bucketSeconds, windowStart).all();

  // multi-wallet actors ("clusters") for the Wallet clusters panel
  const clusters = await env.DB.prepare(
    WHALE_CTE +
      `SELECT wa.actor, t.mint, tm.symbol AS symbol, wa.wallet_count,
              SUM(t.sol_amount) AS total_sol, SUM(t.usd_amount) AS total_usd
       FROM trades t
       JOIN actor_map am ON am.wallet = t.wallet
       JOIN whale_actors wa ON wa.actor = am.actor AND wa.mint = t.mint
       LEFT JOIN token_meta tm ON tm.mint = t.mint
       WHERE t.ts >= ? AND wa.wallet_count > 1
       GROUP BY wa.actor, t.mint
       ORDER BY total_sol DESC
       LIMIT 10`
  ).bind(...cteArgs, windowStart).all();

  const totals = flows.results
    ? flows.results.reduce(
        (a, f) => ({
          net: a.net + (f.buy_sol - f.sell_sol),
          netUsd: a.netUsd + ((f.buy_usd || 0) - (f.sell_usd || 0)),
          whales: a.whales + f.whales,
          actors: a.actors + f.actors,
          sybilActors: a.sybilActors + f.sybil_actors,
          trades: a.trades + f.trades,
        }),
        { net: 0, netUsd: 0, whales: 0, actors: 0, sybilActors: 0, trades: 0 }
      )
    : { net: 0, netUsd: 0, whales: 0, actors: 0, sybilActors: 0, trades: 0 };

  return {
    flows: flows.results || [],
    recent: recent.results || [],
    verdict,
    buckets: buckets.results || [],
    tokenBuckets: tokenBuckets.results || [],
    bucketSeconds,
    clusters: clusters.results || [],
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
    const walletNote =
      f.whales > f.actors ? `, using ${f.whales} wallets (${f.sybil_actors} likely split across wallets)` : "";
    return (
      `${tokenLabel(f)}: buys ${f.buy_sol.toFixed(1)} SOL, sells ${f.sell_sol.toFixed(1)} SOL${usdNote}, ` +
      `net ${(f.buy_sol - f.sell_sol).toFixed(1)} SOL across ${f.trades} trades by ${f.actors} whales${walletNote}`
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
                "Given 24h whale flow data (a 'whale' is an actor whose cumulative volume clears a SOL threshold; " +
                "actors using multiple wallets funded from the same source are already merged into one), state " +
                "for each token: accumulation vs distribution, conviction (how concentrated the buying is vs " +
                "unique whales), and one risk note — flag it if a big share of the flow is coming from wallets " +
                "split across a shared funder, since that often means fewer real independent buyers than it looks. " +
                "Be terse, no hedging boilerplate.\n\nDATA:\n" +
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

/**
 * Shared page chrome for both the flow dashboard and the wallet analyzer.
 * Dark trading-terminal theme: near-black surfaces with depth, monospace
 * tabular numbers wherever a figure appears, a teal/coral glow on the two
 * focal numbers (hero net, live dot), and a couple of small keyframe
 * animations (pulsing live dot, flash-in on a freshly-arrived trade row)
 * used by the in-place polling script below.
 */
const PAGE_CSS = `
  :root{--teal:#1cd9a0;--coral:#ff6b5c;--violet:#8b7cf6;--amber:#e8b34c;
        --ink:#f1f2f5;--mut:#8d909b;--mut2:#6b6e78;
        --line:rgba(255,255,255,.08);--bg:#08090b;--surface:#121317;--surface2:#17181d;
        --mono:ui-monospace,"SF Mono","Cascadia Code","Roboto Mono",Menlo,Consolas,monospace;}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);
       font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif;
       color:var(--ink);padding:16px;max-width:760px;margin:0 auto}
  a{color:inherit}
  .hero{background:linear-gradient(180deg,var(--surface2),var(--surface));border:1px solid var(--line);
        border-radius:18px;padding:22px 22px 6px;margin-bottom:12px;overflow:hidden}
  .htop{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .brand{font-size:18px;font-weight:600;letter-spacing:-0.01em;color:#fff}
  .htag{font-size:11px;color:var(--mut2);margin-left:9px}
  .live{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--teal);font-family:var(--mono)}
  .live b{width:6px;height:6px;border-radius:50%;background:var(--teal);display:inline-block;
          box-shadow:0 0 6px 1px var(--teal);animation:livepulse 1.8s ease-in-out infinite}
  @keyframes livepulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.72)}}
  .navlink{font-size:11px;color:var(--mut);text-decoration:none}
  .tf{display:flex;gap:4px;margin-bottom:10px}
  .tf a{font-size:11px;font-weight:600;color:var(--mut);padding:4px 10px;border-radius:7px;text-decoration:none;background:rgba(255,255,255,.04)}
  .tf a.tfa{background:var(--teal);color:#04140f}
  .hlab{font-size:12px;color:var(--mut);margin-bottom:2px}
  .hlab a{color:var(--mut);text-decoration:none}
  .hero-num{font-size:56px;font-weight:600;letter-spacing:-0.03em;line-height:1;font-family:var(--mono)}
  .hsub{font-size:15px;color:var(--mut);margin-left:10px;font-weight:400}
  .herousd{font-size:13px;color:var(--mut);margin-top:2px;font-family:var(--mono)}
  .pulsewrap{position:relative;height:80px;margin:6px -6px -2px}
  .wsearch{display:flex;gap:8px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:10px 12px;margin-bottom:12px}
  .wsearch input{flex:1;min-width:0;border:none;outline:none;font:13px -apple-system,sans-serif;background:transparent;color:var(--ink)}
  .wsearch input::placeholder{color:var(--mut)}
  .wsearch button{border:none;background:var(--teal);color:#04140f;font-size:12px;font-weight:600;padding:8px 14px;border-radius:9px;cursor:pointer;flex:none}
  .cards{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
  .clab{font-size:11px;color:var(--mut);margin-bottom:8px}
  .cnum{font-size:26px;font-weight:600;letter-spacing:-0.02em;font-family:var(--mono)}
  .csub{font-size:11px;color:var(--mut);margin-top:2px}
  .panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:12px}
  .phead{font-size:12px;color:var(--mut);margin-bottom:12px;display:flex;justify-content:space-between}
  .frow{padding:10px 0;border-top:1px solid var(--line);transition:background-color .6s ease}
  .frow-head{display:flex;align-items:center;gap:7px;margin-bottom:6px}
  .rank{font-size:11px;font-weight:700;color:var(--mut);flex:none;width:20px;font-family:var(--mono)}
  .sym{font-size:13px;font-weight:500;color:var(--ink);text-decoration:none;flex:none}
  .chg{font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;flex:none;font-variant-numeric:tabular-nums;font-family:var(--mono)}
  .chg.pos{background:rgba(28,217,160,.14);color:var(--teal)}
  .chg.neg{background:rgba(255,107,92,.14);color:var(--coral)}
  .warn{font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;flex:none;background:rgba(232,179,76,.14);color:var(--amber)}
  .meta{margin-left:auto;font-size:10px;color:var(--mut);white-space:nowrap;font-variant-numeric:tabular-nums;font-family:var(--mono)}
  .frow-body{display:flex;align-items:center;gap:12px}
  .axis{flex:1;display:flex;align-items:center;height:14px}
  .lft{flex:1;display:flex;justify-content:flex-end}.rgt{flex:1}
  .cen{width:1px;height:16px;background:var(--line)}
  .sell{height:8px;background:var(--coral);border-radius:4px 0 0 4px}
  .buy{display:block;height:8px;background:var(--teal);border-radius:0 4px 4px 0}
  .netcol{display:flex;flex-direction:column;align-items:flex-end;line-height:1.25;flex:none;width:84px}
  .net{text-align:right;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;font-family:var(--mono)}
  .netusd{font-size:10px;color:var(--mut);font-variant-numeric:tabular-nums;font-family:var(--mono)}
  .pos{color:var(--teal)}.neg{color:var(--coral)}
  .dom{position:relative;height:3px;background:var(--line);border-radius:2px;margin-top:8px}
  .dom b{display:block;height:100%;background:var(--violet);border-radius:2px}
  .domlbl{position:absolute;right:0;top:5px;font-size:9px;color:var(--mut);font-family:var(--mono)}
  .spark-row{display:flex;align-items:center;gap:8px;margin-top:8px}
  .spark-lbl{font-size:9px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em;flex:none}
  .spark{flex:none;display:block}
  .spike{font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;flex:none;background:rgba(139,124,246,.16);color:var(--violet);font-family:var(--mono)}
  .disp{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:12px}
  .dtxt{font-size:14px;line-height:1.55;color:var(--ink)}
  .trow-wrap{padding-top:8px;border-top:1px solid var(--line);transition:background-color 1.2s ease}
  .trow-wrap.fresh{background:rgba(28,217,160,.10)}
  .trow{display:grid;grid-template-columns:46px 42px 86px 1fr 82px;align-items:center;gap:8px;font-size:12px}
  .tm{color:var(--mut);font-variant-numeric:tabular-nums;font-family:var(--mono)}
  .side{font-weight:600}.tsol{text-align:right;font-weight:600;font-variant-numeric:tabular-nums;font-family:var(--mono)}
  .tusd{font-weight:400;color:var(--mut);font-size:10px;font-family:var(--mono)}
  .tsym{color:var(--mut);padding-left:8px}
  .tw{text-align:right;color:var(--mut2);text-decoration:none;position:relative}
  .dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--amber);margin-left:5px}
  .tbar{height:2px;border-radius:2px;background:var(--line);margin:6px 0 8px;overflow:hidden}
  .tbar b{display:block;height:100%;border-radius:2px}
  .tbar b.pos{background:var(--teal)}
  .tbar b.neg{background:var(--coral)}
  .empty{color:var(--mut);padding:10px 0;font-size:13px}
  .crow{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line);font-size:12px}
  .csym{font-weight:600;flex:none}
  .cfunder{color:var(--mut);flex:1}
  .ctot{font-weight:600;font-variant-numeric:tabular-nums;flex:none;font-family:var(--mono)}
  .chain{font-size:13px;line-height:2;word-break:break-all;font-family:var(--mono)}
  .chain a{color:var(--ink);text-decoration:none;font-weight:500;padding:2px 6px;background:var(--line);border-radius:6px}
  .siblist{display:flex;flex-direction:column;gap:6px}
  .siblist a{font-size:12px;color:var(--ink);text-decoration:none;padding:6px 8px;background:var(--line);border-radius:8px;word-break:break-all;font-family:var(--mono)}
  .updated{font-size:10px;color:var(--mut2);font-family:var(--mono)}
`;

const SEARCH_FORM = `<form class="wsearch" action="/wallet" method="get">
  <input type="text" name="address" placeholder="Paste a wallet address to analyze…" autocomplete="off" spellcheck="false" required>
  <button type="submit">Analyze →</button>
</form>`;

const htmlPage = (title, body) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${PAGE_CSS}</style></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html;charset=utf-8" } }
  );

async function dashboard(env, window, partial) {
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

  const { flows, recent, verdict, buckets, tokenBuckets, bucketSeconds, clusters, totals } = data;
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
  const heroColor = netPos ? "#1cd9a0" : "#ff6b5c";
  const heroGlow = netPos ? "rgba(28,217,160,.35)" : "rgba(255,107,92,.35)";

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

  // per-token bucket series, for each row's sparkline + spike badge
  const tokenBucketMap = {};
  tokenBuckets.forEach((b) => {
    (tokenBucketMap[b.mint] ||= {})[b.bucket] = b.net;
  });

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

      // this token's own pace over the same ~24 buckets as the hero pulse
      const bm = tokenBucketMap[f.mint] || {};
      const sparkVals = [];
      for (let b = 23; b >= 0; b--) sparkVals.push(bm[nowBucket - b] || 0);
      const lastVal = sparkVals[sparkVals.length - 1];
      const priorVals = sparkVals.slice(0, -1);
      const avgMag = priorVals.reduce((a, v) => a + Math.abs(v), 0) / priorVals.length;
      const lastMag = Math.abs(lastVal);
      const spikeRatio = avgMag > 0 ? lastMag / avgMag : 0;
      const isSpike = avgMag > 0.01 && lastMag >= avgMag * 2;

      return `<div class="frow"${i === 0 ? ' style="border-top:none"' : ""}>
        <div class="frow-head">
          <span class="rank"${i < 3 ? ` style="color:${RANK_COLORS[i]}"` : ""}>#${i + 1}</span>
          <a class="sym" href="https://gmgn.ai/sol/token/${f.mint}" target="_blank">${escapeHtml(tokenLabel(f))}</a>
          ${chg != null ? `<span class="chg ${chg >= 0 ? "pos" : "neg"}">${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%</span>` : ""}
          ${f.sybil_actors > 0 ? `<span class="warn" title="${f.sybil_actors} of these whales trade through more than one wallet sharing a funder">${f.sybil_actors} clustered</span>` : ""}
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
        <div class="spark-row">
          <span class="spark-lbl">pace</span>
          ${sparkline(sparkVals)}
          ${isSpike ? `<span class="spike" title="Latest bucket is ${spikeRatio.toFixed(1)}x this token's average pace">⚡ ${spikeRatio.toFixed(1)}x</span>` : ""}
        </div>
        ${dominance != null ? `<div class="dom" title="Whale-sized volume as a share of ${WINDOW_LABELS[window]} DEX volume"><b style="width:${dominance}%"></b><span class="domlbl">${dominance.toFixed(0)}% whale-dominated</span></div>` : ""}
      </div>`;
    })
    .join("");

  const maxRecentSol = Math.max(1, ...recent.map((r) => r.sol_amount));
  const recentRows = recent
    .map((r, i) => {
      const isBuy = r.side === "BUY";
      const t = new Date(r.ts * 1000);
      const hm = String(t.getUTCHours()).padStart(2, "0") + ":" + String(t.getUTCMinutes()).padStart(2, "0");
      const weightPct = Math.max(4, (r.sol_amount / maxRecentSol) * 100); // floor so small trades still show a sliver
      return `<div class="trow-wrap" data-sig="${escapeHtml(r.signature)}"${i === 0 ? ' style="border-top:none"' : ""}>
        <div class="trow">
          <span class="tm">${hm}</span>
          <span class="side ${isBuy ? "pos" : "neg"}">${r.side}</span>
          <span class="tsol">${r.sol_amount.toFixed(1)} SOL${r.usd_amount != null ? `<br><span class="tusd">$${fmtUsd(r.usd_amount)}</span>` : ""}</span>
          <span class="tsym">${escapeHtml(tokenLabel(r))}</span>
          <a class="tw" href="https://gmgn.ai/sol/address/${r.wallet}" target="_blank">${short(r.wallet)}${r.wallet_count > 1 ? '<b class="dot" title="Part of a multi-wallet cluster"></b>' : ""}</a>
        </div>
        <div class="tbar" title="Size relative to the largest trade shown"><b class="${isBuy ? "pos" : "neg"}" style="width:${weightPct}%"></b></div>
      </div>`;
    })
    .join("");

  const clusterRows = clusters
    .map((c, i) => `<div class="crow"${i === 0 ? ' style="border-top:none"' : ""}>
        <span class="csym">${escapeHtml(tokenLabel(c))}</span>
        <span class="cfunder">funder ${short(c.actor)} → ${c.wallet_count} wallets</span>
        <span class="ctot">${c.total_sol.toFixed(1)} SOL${c.total_usd ? ` · $${fmtUsd(c.total_usd)}` : ""}</span>
      </div>`)
    .join("");

  const contentHtml = `<div class="hero">
  <div class="htop">
    <div><span class="brand">Trnchr</span><span class="htag">whale flow</span></div>
    <span class="live"><b></b>Live <span class="updated" id="updated">now</span></span>
  </div>
  <div class="tf">
    ${Object.keys(WINDOWS).map((w) => `<a href="/?window=${w}"${w === window ? ' class="tfa"' : ""}>${WINDOW_LABELS[w]}</a>`).join("")}
  </div>
  <div class="hlab">Net flow · ${WINDOW_LABELS[window]} · all tokens · ≥${minSol} SOL cumulative per whale</div>
  <div style="display:flex;align-items:baseline">
    <span class="hero-num" style="color:${heroColor};text-shadow:0 0 30px ${heroGlow}">${netPos ? "+" : ""}${Math.round(totals.net)}</span>
    <span class="hsub">SOL ${netPos ? "accumulated" : "distributed"}</span>
  </div>
  ${totals.netUsd ? `<div class="herousd">≈ ${netPos ? "+" : "-"}$${fmtUsd(Math.abs(totals.netUsd))} USD</div>` : ""}
  <div class="pulsewrap"><canvas id="pulse" data-series='${JSON.stringify(series)}' data-color="${heroColor}" style="width:100%;height:80px" role="img" aria-label="${WINDOW_LABELS[window]} cumulative net whale flow"></canvas></div>
</div>

${SEARCH_FORM}

<div class="cards">
  <div class="card"><div class="clab">Whales</div><div class="cnum">${totals.actors}</div><div class="csub">${totals.whales} wallets${totals.sybilActors ? ` · ${totals.sybilActors} clustered` : ""} · ${totals.trades} trades</div></div>
  <div class="card"><div class="clab">Buys</div><div class="cnum pos">${flows.filter(f=>f.buy_sol>0).length}</div><div class="csub">${Math.round(buySol)} SOL${buyUsd ? " · $" + fmtUsd(buyUsd) : ""}</div></div>
  <div class="card"><div class="clab">Sells</div><div class="cnum neg">${flows.filter(f=>f.sell_sol>0).length}</div><div class="csub">${Math.round(sellSol)} SOL${sellUsd ? " · $" + fmtUsd(sellUsd) : ""}</div></div>
</div>

<div class="panel">
  <div class="phead"><span>By token</span><span style="color:var(--mut2)">sell ◂ ▸ buy</span></div>
  ${flows.length ? flowRows : `<div class="empty">No whale trades yet. Once Helius fires, flows appear here.</div>`}
</div>

${clusters.length ? `<div class="panel">
  <div class="phead"><span>Wallet clusters</span><span style="color:var(--mut2)">same funder, multiple wallets</span></div>
  ${clusterRows}
</div>` : ""}

<div class="disp">
  <div class="phead"><span>Analyst dispatch · every 6h</span></div>
  ${verdict ? `<div class="dtxt">${escapeHtml(verdict.summary)}</div>` : `<div class="empty">First dispatch after the next 6-hour run (00/06/12/18 UTC).</div>`}
</div>

<div class="panel">
  <div class="phead"><span>Recent whale trades</span></div>
  ${recent.length ? recentRows : `<div class="empty">Nothing yet.</div>`}
</div>`;

  // Partial fragment for the in-place polling script below — same markup as
  // the full page, just without the <html>/<head>/<script> wrapper, so
  // there is exactly one place that renders any of this, ever.
  if (partial) {
    return new Response(contentHtml, { headers: { "content-type": "text/html;charset=utf-8" } });
  }

  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trnchr — whale flow</title>
<style>${PAGE_CSS}</style></head><body>

<div id="app">${contentHtml}</div>

<script>
(function(){
  function rgba(col,a){var h=col.substring(1);var r=parseInt(h.substr(0,2),16),g=parseInt(h.substr(2,2),16),b=parseInt(h.substr(4,2),16);return "rgba("+r+","+g+","+b+","+a+")";}

  function drawPulse(){
    var cv=document.getElementById('pulse');
    if(!cv) return;
    var S; try{ S=JSON.parse(cv.dataset.series||'[]'); }catch(e){ S=[]; }
    var COL=cv.dataset.color||'#1cd9a0';
    if(!S.length) return;
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
        ctx.fillStyle=head?COL:(x>W*0.7?rgba(COL,0.5):rgba(COL,0.22));
        ctx.beginPath(); ctx.arc(x,y,head?dot+0.6:dot,0,7); ctx.fill();
      }
    }
  }
  drawPulse();

  var CUR_WINDOW=${JSON.stringify(window)};
  var lastUpdate=Date.now();

  function tickUpdated(){
    var el=document.getElementById('updated');
    if(!el) return;
    var s=Math.max(0,Math.round((Date.now()-lastUpdate)/1000));
    el.textContent = s<3 ? 'now' : s+'s ago';
  }
  setInterval(tickUpdated,1000);

  function refresh(){
    var input=document.querySelector('.wsearch input');
    if (document.activeElement===input) return; // don't yank focus/typed text out from under you
    fetch('/?window='+CUR_WINDOW+'&partial=1')
      .then(function(r){ return r.ok ? r.text() : null; })
      .then(function(html){
        if (!html) return;
        var app=document.getElementById('app');
        var oldSigs={};
        app.querySelectorAll('.trow-wrap[data-sig]').forEach(function(el){ oldSigs[el.dataset.sig]=true; });
        app.innerHTML=html;
        drawPulse();
        lastUpdate=Date.now();
        tickUpdated();
        app.querySelectorAll('.trow-wrap[data-sig]').forEach(function(el){
          if (!oldSigs[el.dataset.sig]) {
            el.classList.add('fresh');
            setTimeout(function(){ el.classList.remove('fresh'); },1600);
          }
        });
      })
      .catch(function(){});
  }
  setInterval(refresh,15000);
})();
</script>
</body></html>`;

  return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
}

// ============================================================ WALLET PAGE ==

async function walletPage(env, rawAddress) {
  const address = (rawAddress || "").trim();
  const header = `<div class="hero"><div class="htop">
      <div><span class="brand">Trnchr</span><span class="htag">wallet analyzer</span></div>
      <a class="navlink" href="/">← dashboard</a>
    </div>`;

  if (!address) {
    return htmlPage(
      "Trnchr — wallet analyzer",
      `${header}<div class="hlab">Paste any Solana wallet address to see its trade history in your data, funding chain, and whether it shares a funder with other wallets you've already tracked.</div></div>
      ${SEARCH_FORM}`
    );
  }
  if (!SOLANA_ADDRESS_RE.test(address)) {
    return htmlPage(
      "Trnchr — wallet analyzer",
      `${header}</div>
      ${SEARCH_FORM}
      <div class="panel"><div class="empty">"${escapeHtml(short(address))}" doesn't look like a valid Solana address.</div></div>`
    );
  }

  let data;
  try {
    data = await analyzeWallet(env, address);
  } catch (e) {
    return htmlPage(
      "Trnchr — wallet analyzer",
      `${header}</div>
      ${SEARCH_FORM}
      <div class="panel"><div class="empty">Lookup failed: ${escapeHtml(e.message)}</div></div>`
    );
  }

  const { trades, cluster, heliusEnabled, fundingChain, origin, balanceSol } = data;

  const ageLabel = (() => {
    if (!origin || origin.error || origin.oldest_block_time == null) return origin?.truncated ? "10k+ txs" : "—";
    const days = Math.floor((Date.now() / 1000 - origin.oldest_block_time) / 86400);
    if (days < 1) return "<1 day";
    if (days < 30) return `${days}d`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    return `${(days / 365).toFixed(1)}y`;
  })();

  const chainHtml =
    fundingChain && fundingChain.length
      ? `<div class="chain"><a href="/wallet?address=${address}">${short(address)}</a>${fundingChain
          .map((a) => ` → <a href="/wallet?address=${a}">${short(a)}</a>`)
          .join("")}</div>`
      : `<div class="empty">No funder found — wallet may be brand new, self-funded via a DEX/CEX, or funded by a hub address we don't cluster through.</div>`;

  const originHtml = (() => {
    if (!origin) return `<div class="empty">Unavailable.</div>`;
    if (origin.error) return `<div class="empty">${escapeHtml(origin.error)}</div>`;
    if (!origin.funded_by)
      return `<div class="empty">No incoming SOL transfer found in its earliest known transaction${
        origin.truncated ? " (scan capped at 10k prior txs — this wallet has a long history)" : ""
      }.</div>`;
    return `<div class="chain">
      <a href="/wallet?address=${origin.funded_by}">${short(origin.funded_by)}</a>
      ${origin.funded_amount_sol != null ? ` sent ${origin.funded_amount_sol.toFixed(2)} SOL` : ""}
      ${origin.truncated ? ' <span class="warn" title="Signature scan hit the 10k-tx cap before reaching genesis — this may not be the true first transaction">approx</span>' : ""}
    </div>`;
  })();

  const siblingsHtml =
    cluster && cluster.siblings.length
      ? `<div class="siblist">${cluster.siblings
          .map((s) => `<a href="/wallet?address=${s}">${short(s)}</a>`)
          .join("")}</div>`
      : `<div class="empty">${
          cluster?.funder ? "No other tracked wallets share this funder yet." : "No cached funder for this wallet yet."
        }</div>`;

  const maxWSol = Math.max(1, ...trades.rows.map((r) => r.sol_amount));
  const tradeRowsHtml = trades.rows
    .map((r, i) => {
      const isBuy = r.side === "BUY";
      const t = new Date(r.ts * 1000);
      const hm = String(t.getUTCHours()).padStart(2, "0") + ":" + String(t.getUTCMinutes()).padStart(2, "0");
      const weightPct = Math.max(4, (r.sol_amount / maxWSol) * 100);
      return `<div class="trow-wrap"${i === 0 ? ' style="border-top:none"' : ""}>
        <div class="trow">
          <span class="tm">${hm}</span>
          <span class="side ${isBuy ? "pos" : "neg"}">${r.side}</span>
          <span class="tsol">${r.sol_amount.toFixed(1)} SOL${r.usd_amount != null ? `<br><span class="tusd">$${fmtUsd(r.usd_amount)}</span>` : ""}</span>
          <span class="tsym">${escapeHtml(tokenLabel(r))}</span>
          <a class="tw" href="https://gmgn.ai/sol/token/${r.mint}" target="_blank">view</a>
        </div>
        <div class="tbar"><b class="${isBuy ? "pos" : "neg"}" style="width:${weightPct}%"></b></div>
      </div>`;
    })
    .join("");

  const body = `${header}
  <div class="hlab">${short(address)} · <a href="https://gmgn.ai/sol/address/${address}" target="_blank">GMGN</a> · <a href="https://solscan.io/account/${address}" target="_blank">Solscan</a></div>
  <div style="display:flex;align-items:baseline">
    <span class="hero-num" style="color:#fff;text-shadow:0 0 30px rgba(139,124,246,.35)">${balanceSol != null ? balanceSol.toFixed(2) : "—"}</span>
    <span class="hsub">SOL balance</span>
  </div>
  ${!heliusEnabled ? `<div class="herousd">Set HELIUS_API_KEY to enable balance, funding chain, and wallet-age lookups</div>` : ""}
</div>

${SEARCH_FORM}

<div class="cards">
  <div class="card"><div class="clab">Wallet age</div><div class="cnum">${ageLabel}</div><div class="csub">since earliest known tx</div></div>
  <div class="card"><div class="clab">In your DB</div><div class="cnum">${trades.rows.length}</div><div class="csub">${trades.distinctTokens} token${trades.distinctTokens === 1 ? "" : "s"} traded</div></div>
  <div class="card"><div class="clab">Cluster siblings</div><div class="cnum">${cluster?.siblings?.length || 0}</div><div class="csub">wallets sharing its funder</div></div>
</div>

<div class="panel">
  <div class="phead"><span>Shared-funder wallets</span><span style="color:var(--mut2)">seen in your tracked history</span></div>
  ${siblingsHtml}
</div>

<div class="panel">
  <div class="phead"><span>Most-recent funding chain</span><span style="color:var(--mut2)">wallet → funder → funder's funder</span></div>
  ${heliusEnabled ? chainHtml : `<div class="empty">Set HELIUS_API_KEY to enable this.</div>`}
</div>

<div class="panel">
  <div class="phead"><span>Earliest funder</span><span style="color:var(--mut2)">who first funded this wallet</span></div>
  ${heliusEnabled ? originHtml : `<div class="empty">Set HELIUS_API_KEY to enable this.</div>`}
</div>

<div class="panel">
  <div class="phead"><span>Trade history in Trnchr</span></div>
  ${trades.rows.length ? tradeRowsHtml : `<div class="empty">Not seen in your tracked whale trades.</div>`}
</div>`;

  return htmlPage("Trnchr — wallet analyzer", body);
}

// ============================================================ HELPERS ======

const short = (s) => (s && s.length > 12 ? s.slice(0, 4) + "…" + s.slice(-4) : s || "");
const json = (o, status = 200) =>
  new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json" } });
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/** "$BONK" if we have a Jupiter symbol for this row's mint, else a shortened mint address. */
const tokenLabel = (row) => "$" + (row.symbol || short(row.mint));

/** Tiny inline SVG line sparkline for a token's recent per-bucket net flow (not cumulative — shows pace, not total). */
function sparkline(values) {
  const w = 60, h = 18;
  const max = Math.max(0.001, ...values.map((v) => Math.abs(v)));
  const stepX = w / Math.max(1, values.length - 1);
  const pts = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(h / 2 - (v / max) * (h / 2 - 2)).toFixed(1)}`)
    .join(" ");
  const lastPos = values[values.length - 1] >= 0;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="spark"><polyline points="${pts}" fill="none" stroke="${lastPos ? "#1cd9a0" : "#ff6b5c"}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Compact USD figure: 1.2M, 4.5k, or a plain integer. */
function fmtUsd(n) {
  if (n == null) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toFixed(0);
}
