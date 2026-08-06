# Whale Radar

A tiny agent pipeline that **accumulates Solana whale flows while you sleep**, running entirely on free tiers, set up entirely from a browser. No terminal, ever.

```
Helius (watches the chain, free tier)
   │  pushes every swap on your watchlist tokens
   ▼
Cloudflare Worker  /webhook     ← the COLLECTOR: keeps trades ≥ 25 SOL
   ▼
Cloudflare D1 database          ← the MEMORY: every whale trade, forever
   ▼
Cron every 6 hours              ← the ANALYST: Claude summarises accumulation vs distribution
   ▼
Your worker URL                 ← the DASHBOARD: net flows, bars, verdicts
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

### Step 4 — Set your settings
Cloudflare → **Workers & Pages** → `whale-radar` → **Settings** → **Variables and Secrets** → add:

| Name | Value |
|---|---|
| `WEBHOOK_SECRET` | invent a password, e.g. `radar-9-lives-2026` (no spaces) |
| `MIN_TRADE_SOL` | `25` (or whatever "whale" means to you) |
| `ANTHROPIC_API_KEY` | *(optional)* an API key from console.anthropic.com — turns on the AI analyst |

Click Deploy/Save after adding them.

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
Open `https://whale-radar.YOURNAME.workers.dev` — within minutes of the first ≥25 SOL trade on a watched token, rows appear. The first analyst verdict lands on the next 6-hour mark.

---

## Daily use

- **Dashboard**: your worker URL. Net flow bars per token, unique whale counts, recent big trades (each wallet links to its GMGN profile — that's your bootstrap smart-money research).
- **Change watchlist**: Helius dashboard → edit webhook → add/remove CAs.
- **Change whale threshold**: Cloudflare → worker → Settings → `MIN_TRADE_SOL`.
- **Raw data**: `/api/flows` returns everything as JSON — paste it into a Claude chat for deeper analysis.

## Costs

- Cloudflare Workers + D1 free tier: 100k requests/day, 5GB storage — far more than this needs.
- Helius free tier: enough webhook capacity for a small watchlist.
- Claude API analyst: optional; 4 short calls/day ≈ a few cents.

## Honest limitations (v1)

- Trade sizes are measured in **SOL, not USD** (no price feed dependency; ~simple and reliable).
- Very early **pump.fun bonding-curve** trades don't always parse as clean swaps; tokens that have migrated (Raydium/PumpSwap) work best.
- "Whale" = trade size only. Labeling *which* wallets are smart money is Phase 2 — the wallet links on the dashboard are how you start building that list manually.

## Troubleshooting

- Dashboard says "Database not ready" → Step 3 wasn't finished (ID in wrangler.toml, schema executed).
- Nothing appears → Helius webhook URL must contain `?key=` with your exact secret; check the webhook's delivery logs in Helius.
- Analyst section empty → it only runs at 00:00/06:00/12:00/18:00 UTC, and only if there's data.
