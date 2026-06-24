import pg from "pg";

const { Pool } = pg;

// Neon/Postgres connection string comes from env (DATABASE_URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required by Neon
});

// Create tables on startup (Postgres syntax)
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id   BIGINT PRIMARY KEY,
      username      TEXT,
      balance_usd   DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_earned  DOUBLE PRECISION NOT NULL DEFAULT 0,
      referred_by   BIGINT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS completions (
      id            SERIAL PRIMARY KEY,
      telegram_id   BIGINT NOT NULL,
      network       TEXT NOT NULL,
      network_txn   TEXT NOT NULL,
      gross_usd     DOUBLE PRECISION NOT NULL,
      user_reward   DOUBLE PRECISION NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(network, network_txn)
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id            SERIAL PRIMARY KEY,
      telegram_id   BIGINT NOT NULL,
      amount_usd    DOUBLE PRECISION NOT NULL,
      currency      TEXT NOT NULL DEFAULT 'USDT',
      address       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("Postgres tables ready");
}

init().catch((e) => console.error("DB init error:", e));

export default pool;
