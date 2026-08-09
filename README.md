# Whale Radar

A tiny agent pipeline that **accumulates Solana whale flows while you sleep**, running entirely on free tiers, set up entirely from a browser. No terminal, ever.

```
Helius (watches the chain, free tier)
   │  pushes every swap on your watchlist tokens
   ▼
Cloudflare Worker  /webhook     ← the COLLECTOR: stores every swap ≥ DUST_FLOOR_SOL, prices
   ▼                              them in USD and resolves symbols via Jupiter (free, no key)
Cloudflare D1 database          ← the MEMORY: every trade, forever, plus each wallet's
   ▼                              best-effort funding chain, up to a few hops (via Helius, optional)
Query time                      ← "whale" = an actor (wallet, or wallets sharing a funder)
   ▼                              whose CUMULATIVE volume clears MIN_TRADE_SOL in the window —
   ▼                              catches a big buy split into many small ones
Cron every 6 hours              ← the ANALYST: Claude summarises accumulation vs distribution
   ▼
Your worker URL                 ← the DASHBOARD: ranked flows in SOL & USD, live market stats
                                   (price, mcap, liquidity, whale dominance), wallet clusters,
                                   1H/6H/24H/7D toggle
```

Your **watchlist lives in Helius**, not in code — add or remove a token by editing the webhook in the Helius dashboard. No redeploys.

---

## Setup (about 30 minutes, all in the browser)

### Step 1 — Put this code on GitHub
1. Log in to github.com → **+** (top right) → **New repository** → name it `whale-radar` → Create.
2. Click **uploading an existing file** (link on the empty repo page).
3. Drag in ALL the files from this folder — including the `src` folder (drag the folder itself; GitHub keeps the structure).
4. Click **Commit changes**.

### Step 2 — Connect it to Cloudflare
1. Sign up at dash.cloudflare.com (free plan is fine).
2. Left menu → **Workers & Pages** → **Create** → **Import a repository** → connect your GitHub → pick `whale-radar`.
3. Accept the defaults → **Deploy**. (The first deploy may show an error about the database — that's expected, fix it in Step 3.)
4. Note your worker URL, it looks like `https://whale-radar.YOURNAME.workers.dev`

### Step 3 — Create the database
1. Cloudflare dashboard → **Storage & Databases** → **D1** → **Create database** → name it exactly `whale-radar-db`.
2. On the database page, copy the **Database ID** (a long code like `xxxx-xxxx-...`).
3. Go back to your GitHub repo → open `wrangler.toml` → click the **pencil icon** → replace `REPLACE_ME_WITH_YOUR_DATABASE_ID` with the ID you copied → **Commit changes**. Cloudflare redeploys automatically (watch it under your worker → Deployments).
4. Back in Cloudflare → your D1 database → **Console** tab → paste the entire contents of `schema.sql` → **Execute**.

> **Upgrading an older whale-radar database?** Run whichever of these you're missing once in the same D1 console instead of the full `schema.sql` (existing trades are untouched):
> ```sql
> -- if you don't have USD pricing / symbols yet
> ALTER TABLE trades ADD COLUMN usd_amount REAL;
> CREATE TABLE IF NOT EXISTS token_meta (
>   mint       TEXT PRIMARY KEY,
>   symbol     TEXT,
>   name       TEXT,
>   updated_at INTEGER NOT NULL
> );
> -- if you don't have live market stats yet (price change, market cap, liquidity, volume)
> CREATE TABLE IF NOT EXISTS market_cache (
>   mint             TEXT PRIMARY KEY,
>   price_usd        REAL,
>   price_change_24h REAL,
>   liquidity_usd    REAL,
>   market_cap       REAL,
>   volume_1h        REAL,
>   volume_6h        REAL,
>   volume_24h       REAL,
>   updated_at       INTEGER NOT NULL
> );
> -- if you don't have split-transaction / multi-wallet detection yet
> CREATE INDEX IF NOT EXISTS idx_trades_wallet_ts ON trades (wallet, ts);
> CREATE TABLE IF NOT EXISTS wallet_funding (
>   wallet     TEXT PRIMARY KEY,
>   funded_by  TEXT,
>   checked_at INTEGER NOT NULL
> );
> ```
>
> **Important:** after this migration, "whale" detection changes from "any single trade ≥ `MIN_TRADE_SOL`" to "cumulative volume ≥ `MIN_TRADE_SOL` per actor within the selected window" — see [How whale detection works](#how-whale-detection-works) below. Your Helius webhook config doesn't need to change (it already sends every swap on your watchlist; the size filtering always happened in the Worker, not in Helius).

### Step 4 — Set your settings
Cloudflare → **Workers & Pages** → `whale-radar` → **Settings** → **Variables and Secrets** → add:

| Name | Value |
|---|---|
| `WEBHOOK_SECRET` | invent a password, e.g. `radar-9-lives-2026` (no spaces) |
| `MIN_TRADE_SOL` | `25` (or whatever "whale" means to you) — this is now a **cumulative per-actor** threshold, not a single trade size, see below |
| `DUST_FLOOR_SOL` | *(optional, default `1`)* the smallest single trade worth storing at all — lower catches finer-grained split-transaction structuring, at the cost of more D1 writes |
| `ANTHROPIC_API_KEY` | *(optional)* an API key from console.anthropic.com — turns on the AI analyst |
| `HELIUS_API_KEY` | *(optional)* an API key from your Helius dashboard (Settings → API Keys — different from the webhook secret) — turns on wallet-funding lookups, which cluster whale activity split across multiple wallets |
| `FUNDING_MAX_HOPS` | *(optional, default `2`)* how many funding edges to trace back per wallet — `2` means wallet → funder → funder's funder; only matters with `HELIUS_API_KEY` set |
| `FUNDING_HUB_FANOUT` | *(optional, default `3`)* an address that's funded more than this many distinct wallets is treated as a shared hub (CEX/router) and the chain stops there instead of clustering through it |

Click Deploy/Save after adding them.

USD pricing and token symbols use Jupiter's free public API (lite-api.jup.ag); live price change, market cap, liquidity, and volume use DexScreener's free public API (api.dexscreener.com). Neither needs a key, signup, or extra setting.

### How whale detection works

Filtering by single-trade size is trivial to bypass — split one 100 SOL buy into ten 10 SOL buys and a naive `sol_amount >= threshold` check never fires. So this doesn't filter at ingestion: it stores every trade above the tiny `DUST_FLOOR_SOL` floor, then at query time groups trades by **actor** — a wallet, or (if `HELIUS_API_KEY` is set) a cluster of wallets sharing a funding source — and checks whether that actor's *cumulative* buy+sell volume in the selected time window clears `MIN_TRADE_SOL`. Qualifying actors' full trade history in the window counts toward flows, not just the trade that tipped them over.

Without `HELIUS_API_KEY`, an actor is just its own wallet (still fixes the split-*transaction* case). With it, each wallet's funding chain is traced back up to `FUNDING_MAX_HOPS` edges (wallet → funder → funder's funder by default) and wallets that land on the same chain root are merged into one actor — catching a whale that spreads buys across several wallets, even if those wallets were funded through an extra hop rather than directly. The chain stops early at any address that's already funded more than `FUNDING_HUB_FANOUT` distinct wallets, since that's almost certainly a shared exchange or router, not a personal funding wallet — without that guard, tracing far enough back would eventually converge on some CEX withdrawal address and falsely merge dozens of unrelated whales into one. Detected clusters are surfaced in the **Wallet clusters** panel.

### Step 5 — Point Helius at it
1. Sign up free at helius.dev → dashboard → **Webhooks** → **New Webhook**.
2. Webhook URL:
   `https://whale-radar.YOURNAME.workers.dev/webhook?key=YOUR_WEBHOOK_SECRET`
   (use the exact secret you set in Step 4)
3. Webhook Type: **Enhanced**
4. Transaction Types: **SWAP**
5. Account Addresses: paste the token CAs you want to watch — this is your watchlist. Start with 1–3 tokens, e.g. `Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump`
6. Save.

### Step 6 — Watch it fill up
Open `https://whale-radar.YOURNAME.workers.dev` — within minutes of the first trade that pushes a wallet's cumulative volume on a watched token past your `MIN_TRADE_SOL`, rows appear. The first analyst verdict lands on the next 6-hour mark.

---

## Daily use

- **Dashboard**: your worker URL. Ranked token leaderboard (rank, price change, market cap, liquidity, whale-dominance %), net flow bars, whale/wallet/cluster counts, recent big trades (each wallet links to its GMGN profile — that's your bootstrap smart-money research).
- **Timeframe**: click **1H / 6H / 24H / 7D** at the top of the dashboard, or append `?window=6h` (also `1h`, `24h`, `7d`) to the URL — every number on the page recalculates for that window.
- **Whale dominance**: the thin bar under each token shows whale-sized volume (your DB) as a % of that token's total DEX volume (DexScreener) for the selected window — a rough conviction signal, high = whales are most of the action, low = whale trades are a drop in a much bigger bucket.
- **Wallet clusters**: when `HELIUS_API_KEY` is set, a panel lists actors whose whale-qualifying volume came from more than one wallet sharing a funding source — a small amber "N clustered" badge also appears next to any token with clustered whales, and a dot marks clustered wallets in the recent-trades list.
- **Change watchlist**: Helius dashboard → edit webhook → add/remove CAs.
- **Change whale threshold**: Cloudflare → worker → Settings → `MIN_TRADE_SOL` (cumulative per actor, not per trade — see [How whale detection works](#how-whale-detection-works)).
- **Raw data**: `/api/flows` (optionally `?window=`) returns everything as JSON — paste it into a Claude chat for deeper analysis.

## Costs

- Cloudflare Workers + D1 free tier: 100k requests/day, 5GB storage — should still be plenty for a small watchlist, but note that storing every trade above `DUST_FLOOR_SOL` (instead of only trades already past the whale threshold) means noticeably more D1 writes than earlier versions on an active token. Raise `DUST_FLOOR_SOL` if you're worried about volume.
- Helius free tier: enough webhook capacity for a small watchlist; the optional funding-source lookup uses Helius's Enhanced Transactions API, called once per newly-seen address (wallet, then its funder, then its funder's funder, up to `FUNDING_MAX_HOPS`) and cached for 2 weeks — a deeper `FUNDING_MAX_HOPS` means more calls per new wallet, bounded by the hub cap kicking in once a chain hits shared infrastructure.
- Jupiter Price/Token API and DexScreener API: both free tier, no key required.
- Claude API analyst: optional; 4 short calls/day ≈ a few cents.

## Honest limitations (v1)

- USD trade values are the SOL price *at the moment the trade was recorded*, from Jupiter — if Jupiter is briefly unreachable, that trade's USD figure is left blank (SOL figure is always exact, since it comes straight off-chain).
- Market stats (price change, market cap, liquidity, volume, whale dominance) are *live*, from DexScreener, cached for ~90 seconds — unlike trade USD values, these reflect right now, not the moment of the trade. A token with no indexed DexScreener pair yet just won't show them.
- Token symbols come from Jupiter's token list; very new or unlisted tokens may still show as a shortened contract address until Jupiter indexes them.
- Very early **pump.fun bonding-curve** trades don't always parse as clean swaps; tokens that have migrated (Raydium/PumpSwap) work best.
- Wallet-funding clustering looks at each wallet's most recent handful of transfers and walks a bounded number of hops (`FUNDING_MAX_HOPS`), not an exhaustive forensic graph — it catches same-source sybil wallets a few hops deep, not a determined actor who routes through more hops than that or funds each wallet from a fresh CEX withdrawal. It can also mislabel a DEX/router address as the "funder" if that's genuinely the most recent SOL inflow (e.g. proceeds from an earlier sell) — the hub-fanout cap (`FUNDING_HUB_FANOUT`) catches this once an address has funded enough *distinct* wallets in your own data, but a hub's first appearance can still slip through once. Treat clusters as a strong hint, not proof.
- "Whale" = size (now cumulative per actor, not per trade). Scoring *which* wallets are historically good traders (a true smart-money/PnL score) is still future work — the wallet links on the dashboard are how you start building that list manually.

## Troubleshooting

- Dashboard says "Database not ready" → Step 3 wasn't finished (ID in wrangler.toml, schema executed).
- Nothing appears → Helius webhook URL must contain `?key=` with your exact secret; check the webhook's delivery logs in Helius.
- Analyst section empty → it only runs at 00:00/06:00/12:00/18:00 UTC, and only if there's data.
