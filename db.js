import Database from "better-sqlite3";

const db = new Database("taskapp.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id   INTEGER PRIMARY KEY,
  username      TEXT,
  balance_usd   REAL NOT NULL DEFAULT 0,
  total_earned  REAL NOT NULL DEFAULT 0,
  referred_by   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS completions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id   INTEGER NOT NULL,
  network       TEXT NOT NULL,
  network_txn   TEXT NOT NULL,
  gross_usd     REAL NOT NULL,
  user_reward   REAL NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(network, network_txn)        -- prevents double-credit replays
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id   INTEGER NOT NULL,
  amount_usd    REAL NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'BTC',       -- BTC|LTC|SOL|ETH
  address       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending|paid|rejected|expired
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// --- migration: add currency column if upgrading an existing DB ---
const cols = db.prepare("PRAGMA table_info(withdrawals)").all();
if (!cols.some((c) => c.name === "currency")) {
  db.exec("ALTER TABLE withdrawals ADD COLUMN currency TEXT NOT NULL DEFAULT 'BTC'");
}

export default db;
