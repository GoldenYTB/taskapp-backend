import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pool from "./db-pg.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const USER_RATE = parseFloat(process.env.USER_REWARD_RATE || "0.30");
const REF_RATE = parseFloat(process.env.REFERRAL_RATE || "0.05");
const MIN_WD = parseFloat(process.env.MIN_WITHDRAWAL_USD || "0.10");
const SECRET = process.env.OFFERWALL_SECRET || "change_me";
const ADSGRAM_REWARD_USD = parseFloat(process.env.ADSGRAM_REWARD_USD || "0.001");
const ALLOWED_COINS = ["USDT"];

// ─── register / load a user ──────────────────────────────────────────────────
app.post("/api/user", async (req, res) => {
  const { telegram_id, username, referred_by } = req.body;
  if (!telegram_id) return res.status(400).json({ error: "telegram_id required" });

  let r = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
  if (r.rows.length === 0) {
    await pool.query(
      "INSERT INTO users (telegram_id, username, referred_by) VALUES ($1, $2, $3)",
      [telegram_id, username || null, referred_by || null]
    );
    r = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
  }
  const u = r.rows[0];
  res.json({
    telegram_id: u.telegram_id,
    balance_usd: u.balance_usd,
    total_earned: u.total_earned,
    min_withdrawal: MIN_WD,
  });
});

// ─── Adsgram reward postback ─────────────────────────────────────────────────
// Reward URL: https://YOUR-BACKEND/postback/adsgram?userid=[userId]&key=YOUR_SECRET
app.get("/postback/adsgram", async (req, res) => {
  const { userid, key } = req.query;
  if (!userid) return res.status(400).send("missing userid");
  if (key !== SECRET) return res.status(403).send("bad key");

  const gross = ADSGRAM_REWARD_USD;
  const userReward = +(gross * USER_RATE).toFixed(6);
  const txn = `${userid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await pool.query(
      `INSERT INTO completions (telegram_id, network, network_txn, gross_usd, user_reward)
       VALUES ($1, 'adsgram', $2, $3, $4)`,
      [userid, txn, gross, userReward]
    );
  } catch (e) {
    return res.status(200).send("duplicate ignored");
  }

  await pool.query(
    "UPDATE users SET balance_usd = balance_usd + $1, total_earned = total_earned + $1 WHERE telegram_id = $2",
    [userReward, userid]
  );

  const u = await pool.query("SELECT referred_by FROM users WHERE telegram_id = $1", [userid]);
  if (u.rows[0] && u.rows[0].referred_by) {
    const refBonus = +(gross * REF_RATE).toFixed(6);
    await pool.query(
      "UPDATE users SET balance_usd = balance_usd + $1, total_earned = total_earned + $1 WHERE telegram_id = $2",
      [refBonus, u.rows[0].referred_by]
    );
  }
  res.status(200).send("ok");
});

// ─── transaction history ─────────────────────────────────────────────────────
app.get("/api/transactions", async (req, res) => {
  const { telegram_id } = req.query;
  if (!telegram_id) return res.status(400).json({ error: "telegram_id required" });

  const rewards = await pool.query(
    "SELECT 'reward' AS type, user_reward AS amount, network AS detail, created_at FROM completions WHERE telegram_id = $1 ORDER BY id DESC LIMIT 50",
    [telegram_id]
  );
  const withdrawals = await pool.query(
    "SELECT 'withdrawal' AS type, amount_usd AS amount, status AS detail, created_at FROM withdrawals WHERE telegram_id = $1 ORDER BY id DESC LIMIT 50",
    [telegram_id]
  );
  const all = [...rewards.rows, ...withdrawals.rows]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 50);
  res.json(all);
});

// ─── request a withdrawal (manual approval) ──────────────────────────────────
app.post("/api/withdraw", async (req, res) => {
  const { telegram_id, address, currency } = req.body;
  const coin = (currency || "").toUpperCase();
  const r = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
  if (r.rows.length === 0) return res.status(404).json({ error: "user not found" });
  const u = r.rows[0];
  if (!address) return res.status(400).json({ error: "address required" });
  if (!ALLOWED_COINS.includes(coin)) return res.status(400).json({ error: "Choose USDT" });
  if (u.balance_usd < MIN_WD) return res.status(400).json({ error: `Minimum withdrawal is $${MIN_WD}` });

  const amount = u.balance_usd;
  await pool.query(
    "INSERT INTO withdrawals (telegram_id, amount_usd, currency, address) VALUES ($1, $2, $3, $4)",
    [telegram_id, amount, coin, address]
  );
  await pool.query("UPDATE users SET balance_usd = 0 WHERE telegram_id = $1", [telegram_id]);
  res.json({ status: "pending", amount_usd: amount, currency: coin, message: "Withdrawal queued. Reviewed within 48h or auto-refunded." });
});

// ─── admin: list pending withdrawals ─────────────────────────────────────────
app.get("/admin/withdrawals", async (req, res) => {
  if (req.query.key !== SECRET) return res.status(403).send("forbidden");
  const r = await pool.query("SELECT * FROM withdrawals WHERE status='pending' ORDER BY id DESC");
  res.json(r.rows);
});

// ─── admin: mark a withdrawal paid/rejected ──────────────────────────────────
app.post("/admin/withdrawals/:id", async (req, res) => {
  if (req.query.key !== SECRET) return res.status(403).send("forbidden");
  const { status } = req.body;
  const r = await pool.query("SELECT * FROM withdrawals WHERE id = $1", [req.params.id]);
  if (r.rows.length === 0) return res.status(404).send("not found");
  const w = r.rows[0];
  if (status === "rejected") {
    await pool.query("UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2", [w.amount_usd, w.telegram_id]);
  }
  await pool.query("UPDATE withdrawals SET status = $1 WHERE id = $2", [status, req.params.id]);
  res.json({ ok: true });
});

// ─── 48h auto-expiry: refund stale pending withdrawals ───────────────────────
async function expireStale() {
  const r = await pool.query("SELECT * FROM withdrawals WHERE status='pending' AND created_at <= now() - interval '48 hours'");
  for (const w of r.rows) {
    await pool.query("UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2", [w.amount_usd, w.telegram_id]);
    await pool.query("UPDATE withdrawals SET status='expired' WHERE id = $1", [w.id]);
  }
  if (r.rows.length) console.log(`auto-refunded ${r.rows.length} expired withdrawal(s)`);
}
setInterval(() => expireStale().catch(console.error), 10 * 60 * 1000);

app.listen(process.env.PORT || 3000, () =>
  console.log(`TaskIt (Postgres) running on :${process.env.PORT || 3000}`)
);
