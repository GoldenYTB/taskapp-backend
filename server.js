import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pool from "./db.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const USER_RATE = parseFloat(process.env.USER_REWARD_RATE || "0.30");
const REF_RATE = parseFloat(process.env.REFERRAL_RATE || "0.05");
const MIN_WD = parseFloat(process.env.MIN_WITHDRAWAL_USD || "5.00");
const SECRET = process.env.OFFERWALL_SECRET || "change_me";
const BOT_TOKEN = process.env.BOT_TOKEN || ""; // needed for channel-join verification
const ADSGRAM_REWARD_USD = parseFloat(process.env.ADSGRAM_REWARD_USD || "0.001");
const ALLOWED_COINS = ["USDT", "LTC"];

// new monetization config
const ADS_PER_DAY = parseInt(process.env.ADS_PER_DAY || "20");        // cap of rewarded ads/day
const REF_SIGNUP_BONUS = parseFloat(process.env.REF_SIGNUP_BONUS || "0.001"); // one-time per referral
const STREAK_BONUS = parseFloat(process.env.STREAK_BONUS || "0.0005");        // daily check-in reward

function sameDay(d) {
  if (!d) return false;
  const a = new Date(d), n = new Date();
  return a.getUTCFullYear() === n.getUTCFullYear() && a.getUTCMonth() === n.getUTCMonth() && a.getUTCDate() === n.getUTCDate();
}
function yesterday(d) {
  if (!d) return false;
  const a = new Date(d), n = new Date();
  const diff = Math.floor((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) / 86400000);
  return diff === 1;
}

// ─── register / load a user ──────────────────────────────────────────────────
app.post("/api/user", async (req, res) => {
  const { telegram_id, username, referred_by } = req.body;
  if (!telegram_id) return res.status(400).json({ error: "telegram_id required" });

  let r = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
  let isNew = false;
  if (r.rows.length === 0) {
    // don't let a user refer themselves
    const ref = referred_by && String(referred_by) !== String(telegram_id) ? referred_by : null;
    await pool.query(
      "INSERT INTO users (telegram_id, username, referred_by) VALUES ($1, $2, $3)",
      [telegram_id, username || null, ref]
    );
    isNew = true;
    // credit the referrer: +count and a small one-time bonus
    if (ref) {
      const exists = await pool.query("SELECT 1 FROM users WHERE telegram_id = $1", [ref]);
      if (exists.rows.length) {
        await pool.query(
          "UPDATE users SET ref_count = ref_count + 1, balance_usd = balance_usd + $1, total_earned = total_earned + $1 WHERE telegram_id = $2",
          [REF_SIGNUP_BONUS, ref]
        );
      }
    }
    r = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
  }
  const u = r.rows[0];
  res.json({
    telegram_id: u.telegram_id,
    balance_usd: u.balance_usd,
    total_earned: u.total_earned,
    min_withdrawal: MIN_WD,
    ref_count: u.ref_count,
    streak_days: u.streak_days,
    ads_today: sameDay(u.ads_date) ? u.ads_today : 0,
    ads_max: ADS_PER_DAY,
    is_new: isNew,
  });
});

// ─── Adsgram reward postback ─────────────────────────────────────────────────
// Reward URL: https://YOUR-BACKEND/postback/adsgram?userid=[userId]&key=YOUR_SECRET
app.get("/postback/adsgram", async (req, res) => {
  const { userid, key } = req.query;
  if (!userid) return res.status(400).send("missing userid");
  if (key !== SECRET) return res.status(403).send("bad key");

  // frozen/banned users earn nothing
  const ban = await pool.query("SELECT banned FROM users WHERE telegram_id = $1", [userid]);
  if (ban.rows[0] && ban.rows[0].banned) return res.status(200).send("account frozen");

  // enforce daily ad cap
  const ur = await pool.query("SELECT ads_today, ads_date FROM users WHERE telegram_id = $1", [userid]);
  if (ur.rows.length) {
    const row = ur.rows[0];
    const todayCount = sameDay(row.ads_date) ? row.ads_today : 0;
    if (todayCount >= ADS_PER_DAY) return res.status(200).send("daily cap reached");
    await pool.query(
      "UPDATE users SET ads_today = $1, ads_date = CURRENT_DATE WHERE telegram_id = $2",
      [todayCount + 1, userid]
    );
  }

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

// ─── daily check-in (streak) ─────────────────────────────────────────────────
app.post("/api/checkin", async (req, res) => {
  const { telegram_id } = req.body;
  const r = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
  if (r.rows.length === 0) return res.status(404).json({ error: "user not found" });
  const u = r.rows[0];

  if (sameDay(u.last_checkin)) {
    return res.json({ already: true, streak_days: u.streak_days, message: "Already checked in today" });
  }
  const newStreak = yesterday(u.last_checkin) ? u.streak_days + 1 : 1;
  // streak multiplier: longer streak = bigger bonus, capped at 7x
  const mult = Math.min(newStreak, 7);
  const reward = +(STREAK_BONUS * mult).toFixed(6);

  await pool.query(
    "UPDATE users SET streak_days = $1, last_checkin = CURRENT_DATE, balance_usd = balance_usd + $2, total_earned = total_earned + $2 WHERE telegram_id = $3",
    [newStreak, reward, telegram_id]
  );
  res.json({ streak_days: newStreak, reward, message: `Day ${newStreak} streak! +$${reward}` });
});

// ─── offerwall postback (surveys/installs pay more per action) ────────────────
// Provider posts: https://YOUR-BACKEND/postback/offer?userid=X&txn=Y&payout=Z&key=SECRET
app.get("/postback/offer", async (req, res) => {
  const { userid, txn, payout, key } = req.query;
  if (key !== SECRET) return res.status(403).send("bad key");
  if (!userid || !txn || !payout) return res.status(400).send("missing params");
  const gross = parseFloat(payout);
  if (!(gross > 0)) return res.status(400).send("bad payout");

  const userReward = +(gross * USER_RATE).toFixed(6);
  try {
    await pool.query(
      `INSERT INTO completions (telegram_id, network, network_txn, gross_usd, user_reward)
       VALUES ($1, 'offerwall', $2, $3, $4)`,
      [userid, txn, gross, userReward]
    );
  } catch (e) {
    return res.status(200).send("duplicate ignored");
  }
  await pool.query(
    "UPDATE users SET balance_usd = balance_usd + $1, total_earned = total_earned + $1 WHERE telegram_id = $2",
    [userReward, userid]
  );
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

// ─── TASKS: list active tasks for a user (with completion status) ────────────
app.get("/api/tasks", async (req, res) => {
  const { telegram_id } = req.query;
  const tasks = await pool.query("SELECT id, title, type, target, reward, image_url FROM tasks WHERE active = true ORDER BY id DESC");
  const done = await pool.query("SELECT task_id FROM task_completions WHERE telegram_id = $1", [telegram_id]);
  const doneSet = new Set(done.rows.map(r => r.task_id));
  res.json(tasks.rows.map(t => ({ ...t, completed: doneSet.has(t.id) })));
});

// ─── TASKS: claim a task reward ──────────────────────────────────────────────
// For 'channel' tasks we verify membership via the bot. For 'link' tasks it's tap-to-complete.
app.post("/api/tasks/claim", async (req, res) => {
  const { telegram_id, task_id } = req.body;
  const tr = await pool.query("SELECT * FROM tasks WHERE id = $1 AND active = true", [task_id]);
  if (tr.rows.length === 0) return res.status(404).json({ error: "Task not found" });
  const task = tr.rows[0];

  // already claimed?
  const dup = await pool.query("SELECT 1 FROM task_completions WHERE task_id = $1 AND telegram_id = $2", [task_id, telegram_id]);
  if (dup.rows.length) return res.status(400).json({ error: "Already completed" });

  // verify channel membership via Telegram bot API
  if (task.type === "channel") {
    if (!BOT_TOKEN) return res.status(500).json({ error: "Channel check unavailable (BOT_TOKEN not set)" });
    try {
      // normalize target: strip URL parts, ensure leading @
      let chat = task.target.trim()
        .replace(/^https?:\/\/t\.me\//i, "")
        .replace(/^t\.me\//i, "")
        .replace(/^@/, "");
      chat = "@" + chat;

      const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${telegram_id}`);
      const data = await tgRes.json();

      // Telegram returned an error (usually: bot not admin, or wrong channel)
      if (!data.ok) {
        const desc = (data.description || "").toLowerCase();
        if (desc.includes("chat not found"))
          return res.status(400).json({ error: "Channel not found — check the @username" });
        if (desc.includes("member list is inaccessible") || desc.includes("not enough rights") || desc.includes("administrator"))
          return res.status(400).json({ error: "Bot must be an admin of the channel" });
        return res.status(400).json({ error: "Channel check failed: " + (data.description || "unknown") });
      }

      const status = data?.result?.status;
      const isMember = ["member", "administrator", "creator"].includes(status);
      if (!isMember) return res.status(400).json({ error: "Join the channel first, then tap again" });
    } catch (e) {
      return res.status(500).json({ error: "Could not verify membership" });
    }
  }

  // credit the reward
  try {
    await pool.query("INSERT INTO task_completions (task_id, telegram_id) VALUES ($1, $2)", [task_id, telegram_id]);
  } catch (e) {
    return res.status(400).json({ error: "Already completed" });
  }
  await pool.query(
    "UPDATE users SET balance_usd = balance_usd + $1, total_earned = total_earned + $1 WHERE telegram_id = $2",
    [task.reward, telegram_id]
  );
  res.json({ ok: true, reward: task.reward, message: `+$${task.reward} earned!` });
});

// ─── ADMIN: add a task ───────────────────────────────────────────────────────
app.post("/admin/tasks", async (req, res) => {
  if (req.query.key !== SECRET) return res.status(403).send("forbidden");
  const { title, type, target, reward, image_url } = req.body;
  if (!title || !target || !reward) return res.status(400).json({ error: "title, target, reward required" });
  const t = (type === "channel") ? "channel" : "link";
  const r = await pool.query(
    "INSERT INTO tasks (title, type, target, reward, image_url) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [title, t, target, parseFloat(reward), image_url || null]
  );
  res.json({ ok: true, id: r.rows[0].id });
});

// ─── ADMIN: list all tasks ───────────────────────────────────────────────────
app.get("/admin/tasks", async (req, res) => {
  if (req.query.key !== SECRET) return res.status(403).send("forbidden");
  const r = await pool.query("SELECT * FROM tasks ORDER BY id DESC");
  res.json(r.rows);
});

// ─── ADMIN: remove (deactivate) a task ───────────────────────────────────────
app.post("/admin/tasks/:id/remove", async (req, res) => {
  if (req.query.key !== SECRET) return res.status(403).send("forbidden");
  await pool.query("UPDATE tasks SET active = false WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// ─── ADMIN: manually credit (or deduct) a user's balance ─────────────────────
app.post("/admin/credit", async (req, res) => {
  if (req.query.key !== SECRET) return res.status(403).send("forbidden");
  const { telegram_id, amount } = req.body;
  const amt = parseFloat(amount);
  if (!telegram_id || isNaN(amt)) return res.status(400).json({ error: "telegram_id and amount required" });
  const u = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
  if (u.rows.length === 0) return res.status(404).json({ error: "User not found" });
  await pool.query(
    "UPDATE users SET balance_usd = balance_usd + $1, total_earned = total_earned + GREATEST($1,0) WHERE telegram_id = $2",
    [amt, telegram_id]
  );
  const updated = await pool.query("SELECT balance_usd FROM users WHERE telegram_id = $1", [telegram_id]);
  res.json({ ok: true, new_balance: updated.rows[0].balance_usd });
});

// ─── request a withdrawal (manual approval) ──────────────────────────────────
app.post("/api/withdraw", async (req, res) => {
  const { telegram_id, address, currency } = req.body;
  const coin = (currency || "").toUpperCase();
  const r = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
  if (r.rows.length === 0) return res.status(404).json({ error: "user not found" });
  const u = r.rows[0];
  if (u.banned) return res.status(403).json({ error: "Account frozen. Contact support." });
  if (!address) return res.status(400).json({ error: "address required" });
  if (!ALLOWED_COINS.includes(coin)) return res.status(400).json({ error: "Choose USDT or LTC" });
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
// ─── post a payout proof to the proof channel ───────────────────────────────
const PROOF_CHANNEL = process.env.PROOF_CHANNEL || ""; // e.g. @CrypticPayouts or -100123...
async function postProof({ amount, currency, txId, note }) {
  if (!BOT_TOKEN || !PROOF_CHANNEL) return { ok: false, reason: "channel not configured" };
  const lines = [
    "✅ *Payout Sent!*",
    "",
    `💰 Amount: *$${Number(amount).toFixed(2)} ${currency || "USDT"}*`,
  ];
  if (txId) lines.push(`🔗 Transaction: \`${txId}\``);
  if (note) lines.push(`📝 ${note}`);
  lines.push("", "Earn yours on TaskIt 👉 @TaskIt_officialbot");
  const text = lines.join("\n");
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: PROOF_CHANNEL, text, parse_mode: "Markdown", disable_web_page_preview: true }),
    });
    const d = await r.json();
    return { ok: d.ok, reason: d.description };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

app.post("/admin/withdrawals/:id", async (req, res) => {
  if (req.query.key !== SECRET) return res.status(403).send("forbidden");
  const { status, tx_id, post_proof } = req.body;
  const r = await pool.query("SELECT * FROM withdrawals WHERE id = $1", [req.params.id]);
  if (r.rows.length === 0) return res.status(404).send("not found");
  const w = r.rows[0];
  if (status === "rejected") {
    await pool.query("UPDATE users SET balance_usd = balance_usd + $1 WHERE telegram_id = $2", [w.amount_usd, w.telegram_id]);
  }
  await pool.query("UPDATE withdrawals SET status = $1 WHERE id = $2", [status, req.params.id]);

  // auto-post proof when marked paid (unless caller opts out)
  let proof = null;
  if (status === "paid" && post_proof !== false) {
    proof = await postProof({ amount: w.amount_usd, currency: w.currency, txId: tx_id });
  }
  res.json({ ok: true, proof });
});

// ─── manual proof post (paste your own details + tx id) ──────────────────────
app.post("/admin/proof", async (req, res) => {
  if (req.query.key !== SECRET) return res.status(403).send("forbidden");
  const { amount, currency, tx_id, note } = req.body;
  if (!amount) return res.status(400).json({ error: "amount required" });
  const result = await postProof({ amount, currency, txId: tx_id, note });
  if (!result.ok) return res.status(500).json({ error: result.reason || "post failed" });
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
