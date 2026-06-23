import express from "express";
import cors from "cors";
import crypto from "crypto";
import dotenv from "dotenv";
import db from "./db.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const USER_RATE = parseFloat(process.env.USER_REWARD_RATE || "0.30");
const REF_RATE = parseFloat(process.env.REFERRAL_RATE || "0.05");
const MIN_WD = parseFloat(process.env.MIN_WITHDRAWAL_USD || "0.10");
const SECRET = process.env.OFFERWALL_SECRET || "change_me";

// --- helper: get or create user ---
function getUser(id, username, referredBy) {
  let u = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(id);
  if (!u) {
    db.prepare(
      "INSERT INTO users (telegram_id, username, referred_by) VALUES (?, ?, ?)"
    ).run(id, username || null, referredBy || null);
    u = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(id);
  }
  return u;
}

// --- register / load a user (called by the Mini App on open) ---
app.post("/api/user", (req, res) => {
  const { telegram_id, username, referred_by } = req.body;
  if (!telegram_id) return res.status(400).json({ error: "telegram_id required" });
  const u = getUser(telegram_id, username, referred_by);
  res.json({
    telegram_id: u.telegram_id,
    balance_usd: u.balance_usd,
    total_earned: u.total_earned,
    min_withdrawal: MIN_WD,
  });
});

// --- offerwall postback (the network calls this when a task completes) ---
// Configure each network's postback URL as:
//   https://your-backend/postback/<network>?user_id={uid}&txn={txn}&payout={usd}&sig={hash}
app.get("/postback/:network", (req, res) => {
  const { network } = req.params;
  const { user_id, txn, payout, sig } = req.query;

  if (!user_id || !txn || !payout) return res.status(400).send("missing params");

  // verify signature so nobody can forge completions
  const expected = crypto
    .createHash("sha256")
    .update(`${user_id}:${txn}:${payout}:${SECRET}`)
    .digest("hex");
  if (sig !== expected) return res.status(403).send("bad signature");

  const gross = parseFloat(payout);
  if (!(gross > 0)) return res.status(400).send("bad payout");

  const userReward = +(gross * USER_RATE).toFixed(4); // user gets 30%, you keep 70%

  try {
    const insert = db.prepare(
      `INSERT INTO completions (telegram_id, network, network_txn, gross_usd, user_reward)
       VALUES (?, ?, ?, ?, ?)`
    );
    insert.run(user_id, network, txn, gross, userReward);
  } catch (e) {
    // UNIQUE(network, txn) violation = replay, ignore safely
    return res.status(200).send("duplicate ignored");
  }

  db.prepare(
    "UPDATE users SET balance_usd = balance_usd + ?, total_earned = total_earned + ? WHERE telegram_id = ?"
  ).run(userReward, userReward, user_id);

  // optional referral bonus, paid from YOUR cut (not the user's)
  const u = db.prepare("SELECT referred_by FROM users WHERE telegram_id = ?").get(user_id);
  if (u && u.referred_by) {
    const refBonus = +(gross * REF_RATE).toFixed(4);
    db.prepare(
      "UPDATE users SET balance_usd = balance_usd + ?, total_earned = total_earned + ? WHERE telegram_id = ?"
    ).run(refBonus, refBonus, u.referred_by);
  }

  res.status(200).send("ok");
});

// --- Adsgram reward postback ---
// Adsgram replaces [userId] with the user's Telegram ID and sends a GET to this URL
// when a rewarded ad is fully watched. Adsgram does NOT send a signature, so we protect
// the endpoint with a secret token baked into the URL (the `key` param).
// Set your Adsgram "Reward URL" to:
//   https://YOUR-BACKEND/postback/adsgram?userid=[userId]&key=YOUR_SECRET
const ADSGRAM_REWARD_USD = parseFloat(process.env.ADSGRAM_REWARD_USD || "0.001");

app.get("/postback/adsgram", (req, res) => {
  const { userid, key } = req.query;
  if (!userid) return res.status(400).send("missing userid");

  // protect the endpoint: the secret travels in the URL as `key`
  if (key !== SECRET) return res.status(403).send("bad key");

  const gross = ADSGRAM_REWARD_USD;
  const userReward = +(gross * USER_RATE).toFixed(4); // user 30%, you keep 70%

  // Adsgram doesn't supply a transaction id, so generate a unique one per reward.
  const txn = `${userid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    db.prepare(
      `INSERT INTO completions (telegram_id, network, network_txn, gross_usd, user_reward)
       VALUES (?, 'adsgram', ?, ?, ?)`
    ).run(userid, txn, gross, userReward);
  } catch (e) {
    return res.status(200).send("duplicate ignored");
  }

  db.prepare(
    "UPDATE users SET balance_usd = balance_usd + ?, total_earned = total_earned + ? WHERE telegram_id = ?"
  ).run(userReward, userReward, userid);

  const u = db.prepare("SELECT referred_by FROM users WHERE telegram_id = ?").get(userid);
  if (u && u.referred_by) {
    const refBonus = +(gross * REF_RATE).toFixed(4);
    db.prepare(
      "UPDATE users SET balance_usd = balance_usd + ?, total_earned = total_earned + ? WHERE telegram_id = ?"
    ).run(refBonus, refBonus, u.referred_by);
  }

  res.status(200).send("ok");
});

// --- request a withdrawal (MANUAL approval) ---
const ALLOWED_COINS = ["USDT"]; // USDT on the TON blockchain only

app.post("/api/withdraw", (req, res) => {
  const { telegram_id, address, currency } = req.body;
  const coin = (currency || "").toUpperCase();
  const u = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegram_id);
  if (!u) return res.status(404).json({ error: "user not found" });
  if (!address) return res.status(400).json({ error: "address required" });
  if (!ALLOWED_COINS.includes(coin))
    return res.status(400).json({ error: "Choose BTC, LTC, SOL, or ETH" });
  if (u.balance_usd < MIN_WD)
    return res.status(400).json({ error: `Minimum withdrawal is $${MIN_WD}` });

  const amount = u.balance_usd;
  db.prepare(
    "INSERT INTO withdrawals (telegram_id, amount_usd, currency, address) VALUES (?, ?, ?, ?)"
  ).run(telegram_id, amount, coin, address);
  db.prepare("UPDATE users SET balance_usd = 0 WHERE telegram_id = ?").run(telegram_id);

  res.json({
    status: "pending",
    amount_usd: amount,
    currency: coin,
    message: "Withdrawal queued. Reviewed within 48h or auto-refunded.",
  });
});

// --- admin: list pending withdrawals (protect this in production!) ---
app.get("/admin/withdrawals", (req, res) => {
  if (req.query.key !== SECRET) return res.status(403).send("forbidden");
  const rows = db.prepare("SELECT * FROM withdrawals WHERE status='pending'").all();
  res.json(rows);
});

// --- admin: mark a withdrawal paid/rejected ---
app.post("/admin/withdrawals/:id", (req, res) => {
  if (req.query.key !== SECRET) return res.status(403).send("forbidden");
  const { status } = req.body; // 'paid' | 'rejected'
  const w = db.prepare("SELECT * FROM withdrawals WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send("not found");
  if (status === "rejected") {
    // refund the balance
    db.prepare("UPDATE users SET balance_usd = balance_usd + ? WHERE telegram_id = ?")
      .run(w.amount_usd, w.telegram_id);
  }
  db.prepare("UPDATE withdrawals SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json({ ok: true });
});

// --- 48h auto-expiry: refund any pending withdrawal older than 48 hours ---
function expireStaleWithdrawals() {
  const stale = db
    .prepare(
      "SELECT * FROM withdrawals WHERE status='pending' AND created_at <= datetime('now','-48 hours')"
    )
    .all();
  for (const w of stale) {
    db.prepare("UPDATE users SET balance_usd = balance_usd + ? WHERE telegram_id = ?")
      .run(w.amount_usd, w.telegram_id);
    db.prepare("UPDATE withdrawals SET status='expired' WHERE id = ?").run(w.id);
  }
  if (stale.length) console.log(`auto-refunded ${stale.length} expired withdrawal(s)`);
}

// run at startup and every 10 minutes
expireStaleWithdrawals();
setInterval(expireStaleWithdrawals, 10 * 60 * 1000);

app.listen(process.env.PORT || 3000, () =>
  console.log(`backend running on :${process.env.PORT || 3000}`)
);
