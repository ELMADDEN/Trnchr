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

CREATE INDEX IF NOT EXISTS idx_trades_mint_ts ON trades (mint, ts);
CREATE INDEX IF NOT EXISTS idx_trades_wallet  ON trades (wallet);

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
