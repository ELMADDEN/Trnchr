-- Whale Radar schema. Paste this whole file into the D1 console
-- (Cloudflare dashboard -> Storage & Databases -> D1 -> whale-radar-db -> Console)
-- and press Execute.

CREATE TABLE IF NOT EXISTS trades (
  signature   TEXT PRIMARY KEY,      -- transaction signature (prevents duplicates)
  ts          INTEGER NOT NULL,      -- unix timestamp of the trade
  wallet      TEXT NOT NULL,         -- the trader's wallet address
  mint        TEXT NOT NULL,         -- token contract address (CA)
  side        TEXT NOT NULL,         -- 'BUY' or 'SELL'
  sol_amount  REAL NOT NULL,         -- trade size in SOL
  usd_amount  REAL,                  -- trade size in USD at trade time (via Jupiter Price API), NULL if the lookup failed
  received_at INTEGER NOT NULL       -- when the webhook arrived
);

CREATE INDEX IF NOT EXISTS idx_trades_mint_ts   ON trades (mint, ts);
CREATE INDEX IF NOT EXISTS idx_trades_wallet     ON trades (wallet);
CREATE INDEX IF NOT EXISTS idx_trades_wallet_ts  ON trades (wallet, ts);

CREATE TABLE IF NOT EXISTS verdicts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  summary    TEXT NOT NULL           -- the analyst's write-up
);

-- Cache of mint -> symbol/name from Jupiter's Token API, so the dashboard
-- doesn't need to call Jupiter on every page load.
CREATE TABLE IF NOT EXISTS token_meta (
  mint       TEXT PRIMARY KEY,       -- token contract address (CA)
  symbol     TEXT,                   -- e.g. 'BONK'
  name       TEXT,                   -- e.g. 'Bonk'
  updated_at INTEGER NOT NULL        -- unix timestamp of last refresh
);

-- Short-lived cache of live market stats from DexScreener (price, market
-- cap, liquidity, volume), so a busy dashboard doesn't hammer the API.
CREATE TABLE IF NOT EXISTS market_cache (
  mint             TEXT PRIMARY KEY, -- token contract address (CA)
  price_usd        REAL,
  price_change_24h REAL,             -- percent, e.g. 12.4 means +12.4%
  liquidity_usd    REAL,
  market_cap       REAL,
  volume_1h        REAL,
  volume_6h        REAL,
  volume_24h       REAL,
  updated_at       INTEGER NOT NULL  -- unix timestamp of last refresh
);

-- Best-effort cache of each wallet's most recent external SOL funder, used
-- to cluster split-across-wallets whale activity into one "actor". Only
-- populated when HELIUS_API_KEY is set; a NULL funded_by just means the
-- wallet is treated as its own actor (which is also the correct fallback
-- when this table is empty entirely).
CREATE TABLE IF NOT EXISTS wallet_funding (
  wallet     TEXT PRIMARY KEY,       -- the trader's wallet address
  funded_by  TEXT,                   -- best-effort: address that most recently sent it SOL
  checked_at INTEGER NOT NULL        -- unix timestamp of last lookup
);
