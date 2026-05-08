/**
 * MobCash Agent Bot — server.js
 * Combines Telegram webhook + Express admin dashboard in one process
 * Deploy to Heroku with one dyno.
 */

require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const cors = require("cors");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID);
const APP_URL = process.env.APP_URL || "";
const IS_PROD = process.env.NODE_ENV === "production";

// ─── In-Memory Store (swap with MongoDB/PostgreSQL for scale) ──────────────
// applications[chatId] = { status, data, adminNotified, chatId, submittedAt }
const applications = {};
// sessions[chatId] = { step, data }
const userSessions = {};

// ─── Bot Setup ─────────────────────────────────────────────────────────────
let bot;
if (IS_PROD) {
  bot = new TelegramBot(TOKEN);
  // Webhook will be set after server starts
} else {
  bot = new TelegramBot(TOKEN, { polling: true });
}

// ─── Express Middleware ────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "mobcash_secret_key_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: IS_PROD, maxAge: 24 * 60 * 60 * 1000 },
  })
);
app.use(express.static(path.join(__dirname, "admin/public")));

// ─── Webhook Route ─────────────────────────────────────────────────────────
if (IS_PROD) {
  app.post(`/webhook/${TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

// ─── Auth Middleware ───────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.redirect("/login");
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function getSession(chatId) {
  if (!userSessions[chatId]) userSessions[chatId] = { step: "start", data: {} };
  return userSessions[chatId];
}
function resetSession(chatId) {
  userSessions[chatId] = { step: "start", data: {} };
}

function isValidName(name) {
  if (!name || name.length > 40) return false;
  const words = name.trim().split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  const wordPattern = /^[A-Za-zÀ-ÖØ-öø-ÿА-Яа-яЁё][A-Za-zÀ-ÖØ-öø-ÿА-Яа-яЁё'\-.]*$/;
  return words.every((w) => wordPattern.test(w));
}

function isValidPlayerId(id) {
  return /^\d{9,11}$/.test((id || "").trim());
}

const CURRENCIES = [
  { code: "USD", label: "🇺🇸 USD (Default)" },
  { code: "EUR", label: "🇪🇺 EUR" },
  { code: "RUB", label: "🇷🇺 RUB" },
  { code: "UZS", label: "🇺🇿 UZS" },
  { code: "KZT", label: "🇰🇿 KZT" },
  { code: "TRY", label: "🇹🇷 TRY" },
  { code: "BRL", label: "🇧🇷 BRL" },
  { code: "MAD", label: "🇲🇦 MAD" },
];

// ─── Keyboards ─────────────────────────────────────────────────────────────
const agreeKb = () => ({ inline_keyboard: [[{ text: "✅ I Agree", callback_data: "agree" }]] });
const locationKb = () => ({
  keyboard: [[{ text: "📍 Share My Location", request_location: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
});
const contactKb = () => ({
  keyboard: [[{ text: "📱 Share My Contact", request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
});
const removeKb = () => ({ remove_keyboard: true });
const currencyKb = () => {
  const rows = [];
  for (let i = 0; i < CURRENCIES.length; i += 2) {
    const row = [{ text: CURRENCIES[i].label, callback_data: `cur_${CURRENCIES[i].code}` }];
    if (CURRENCIES[i + 1]) row.push({ text: CURRENCIES[i + 1].label, callback_data: `cur_${CURRENCIES[i + 1].code}` });
    rows.push(row);
  }
  return { inline_keyboard: rows };
};
const expKb = () => ({
  inline_keyboard: [
    [
      { text: "✅ Yes", callback_data: "exp_yes" },
      { text: "❌ No", callback_data: "exp_no" },
    ],
  ],
});
const topupKb = () => ({
  inline_keyboard: [
    [
      { text: "💎 USDT", callback_data: "topup_usdt" },
      { text: "🪙 Other Crypto", callback_data: "topup_other" },
    ],
  ],
});
const statusKb = () => ({
  inline_keyboard: [[{ text: "📋 Check My Application Status", callback_data: "check_status" }]],
});

// ─── Admin Notification ────────────────────────────────────────────────────
async function notifyAdmin(chatId, data) {
  const text =
    `🆕 *New Agent Application*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 *Name:* ${data.fullName}\n` +
    `📞 *Phone:* ${data.phone}\n` +
    `💱 *Currency:* ${data.currency}\n` +
    `🏙️ *Street:* ${data.street}\n` +
    `🎮 *Player ID:* ${data.playerId}\n` +
    `💰 *Top-up:* ${data.topup}\n` +
    `🧑‍💼 *Experience:* ${data.experience}\n` +
    `📍 *Location:* ${data.location ? `${data.location.latitude}, ${data.location.longitude}` : "N/A"}\n` +
    `🆔 *TG User ID:* \`${chatId}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  const actionKb = {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `admin_approve_${chatId}` },
        { text: "❌ Reject", callback_data: `admin_reject_${chatId}` },
      ],
    ],
  };

  // Send ID photos as media group if available
  if (data.idPhotos && data.idPhotos.length > 0) {
    const media = data.idPhotos.map((fid, i) => ({
      type: "photo",
      media: fid,
      ...(i === 0 ? { caption: `📸 ID Documents for application`, parse_mode: "Markdown" } : {}),
    }));
    await bot.sendMediaGroup(ADMIN_CHAT_ID, media);
  }

  await bot.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: "Markdown", reply_markup: actionKb });

  applications[String(chatId)] = {
    status: "pending",
    data,
    chatId: String(chatId),
    submittedAt: new Date().toISOString(),
    adminMessages: [],
  };
}

// ─── /start ────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || "User";
  resetSession(chatId);
  userSessions[chatId].step = "awaiting_agree";

  await bot.sendMessage(
    chatId,
    `👋 Hello, *${name}*!\n\n` +
      `📜 *User Agreement*\n\n` +
      `The User Agreement covers the processing of personal data, prohibits copying any bot functions, and requires non-disclosure of confidential information obtained through the use of both proprietary software and free distributions that include proprietary elements.\n\n` +
      `By clicking *I Agree* you accept all terms and conditions.`,
    { parse_mode: "Markdown", reply_markup: agreeKb() }
  );
});

// ─── /status ──────────────────────────────────────────────────────────────
bot.onText(/\/status/, async (msg) => {
  const chatId = String(msg.chat.id);
  const app = applications[chatId];
  if (!app) return bot.sendMessage(chatId, "❌ No application found. Use /start to apply.");
  const icons = { pending: "⏳", approved: "✅", rejected: "❌" };
  bot.sendMessage(chatId, `📋 Application Status: ${icons[app.status] || "❓"} *${app.status.toUpperCase()}*`, { parse_mode: "Markdown" });
});

// ─── Callback Queries ──────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const strId = String(chatId);
  const data = query.data;
  const sess = getSession(chatId);

  await bot.answerCallbackQuery(query.id).catch(() => {});

  // ── Agree ──
  if (data === "agree" && sess.step === "awaiting_agree") {
    sess.step = "awaiting_location";
    return bot.sendMessage(chatId, "📍 *Share your location* (only works on smartphones) via the button below.", {
      parse_mode: "Markdown",
      reply_markup: locationKb(),
    });
  }

  // ── Currency ──
  if (data.startsWith("cur_") && sess.step === "awaiting_currency") {
    sess.data.currency = data.replace("cur_", "");
    sess.step = "awaiting_id_photo";
    return bot.sendMessage(
      chatId,
      `✅ Currency set to *${sess.data.currency}*\n\n` +
        `📸 *Share your Real Identity Document Photo*\n` +
        `(Passport / ID Card / Driving License)\n\n` +
        `Send your first photo now. You can send multiple photos.`,
      { parse_mode: "Markdown", reply_markup: removeKb() }
    );
  }

  // ── Experience ──
  if ((data === "exp_yes" || data === "exp_no") && sess.step === "awaiting_experience") {
    sess.data.experience = data === "exp_yes" ? "Yes" : "No";
    sess.step = "awaiting_street";
    return bot.sendMessage(
      chatId,
      `🏙️ *Please enter your street name:*\n\n` +
        `• Must be understandable and easily readable\n` +
        `• Enter the name only, not the full address\n` +
        `• It will be visible to players choosing a cashier`,
      { parse_mode: "Markdown", reply_markup: removeKb() }
    );
  }

  // ── Top-up ──
  if ((data === "topup_usdt" || data === "topup_other") && sess.step === "awaiting_topup") {
    sess.data.topup = data === "topup_usdt" ? "USDT" : "Other Crypto";
    sess.step = "awaiting_player_id";
    return bot.sendMessage(
      chatId,
      `🎮 *Send your gaming ID* from your 7starswin profile.\n\n` +
        `_It's a 9–11 digit number. You can copy it in the app._`,
      { parse_mode: "Markdown", reply_markup: removeKb() }
    );
  }

  // ── Check Status ──
  if (data === "check_status") {
    const app = applications[strId];
    if (!app) return bot.sendMessage(chatId, "❌ No application found.");
    const icons = { pending: "⏳", approved: "✅", rejected: "❌" };
    return bot.sendMessage(chatId, `📋 Status: ${icons[app.status]} *${app.status.toUpperCase()}*`, { parse_mode: "Markdown" });
  }

  // ── Admin: Approve ──
  if (data.startsWith("admin_approve_") && strId === ADMIN_CHAT_ID) {
    const targetId = data.replace("admin_approve_", "");
    if (applications[targetId]) {
      applications[targetId].status = "approved";
      applications[targetId].approvedAt = new Date().toISOString();
    }
    await bot.sendMessage(
      targetId,
      `🎉 *Congratulations!* Your MobCash agent application has been *APPROVED!*\n\nOur manager will contact you shortly. Welcome to the team! 🚀`,
      { parse_mode: "Markdown", reply_markup: statusKb() }
    );
    await bot.editMessageText(`✅ Application of user ${targetId} has been *APPROVED*.`, {
      chat_id: ADMIN_CHAT_ID,
      message_id: query.message.message_id,
      parse_mode: "Markdown",
    }).catch(() => {});
    return;
  }

  // ── Admin: Reject (enter reject mode) ──
  if (data.startsWith("admin_reject_") && strId === ADMIN_CHAT_ID) {
    const targetId = data.replace("admin_reject_", "");
    userSessions[ADMIN_CHAT_ID] = userSessions[ADMIN_CHAT_ID] || { step: "idle", data: {} };
    userSessions[ADMIN_CHAT_ID].step = `admin_rejecting_${targetId}`;
    return bot.sendMessage(
      ADMIN_CHAT_ID,
      `✏️ Type your rejection reason for user *${targetId}*.\nYou can also send a photo or video.`,
      { parse_mode: "Markdown" }
    );
  }

  // ── Photo done (inline button after ID photos) ──
  if (data === "photos_done" && sess.step === "awaiting_id_photo") {
    if (!sess.data.idPhotos || sess.data.idPhotos.length === 0) {
      return bot.sendMessage(chatId, "⚠️ Please send at least one photo first.");
    }
    sess.step = "awaiting_experience";
    return bot.sendMessage(
      chatId,
      `✅ Photos received!\n\n` +
        `💼 *Do you have experience working with the MobCash mobile app?*`,
      { parse_mode: "Markdown", reply_markup: expKb() }
    );
  }
});

// ─── Message Handler ───────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const strId = String(chatId);
  const sess = getSession(chatId);

  // ── Admin rejection (text/photo/video) ──
  if (strId === ADMIN_CHAT_ID && sess.step && sess.step.startsWith("admin_rejecting_")) {
    const targetId = sess.step.replace("admin_rejecting_", "");
    if (applications[targetId]) {
      applications[targetId].status = "rejected";
      applications[targetId].rejectedAt = new Date().toISOString();
      applications[targetId].rejectReason = msg.text || msg.caption || "No reason provided";
    }
    const prefix = `❌ *Your MobCash agent application has been rejected.*\n\n📝 *Admin:*\n`;

    if (msg.photo) {
      const fid = msg.photo[msg.photo.length - 1].file_id;
      await bot.sendPhoto(targetId, fid, { caption: prefix + (msg.caption || ""), parse_mode: "Markdown" });
    } else if (msg.video) {
      await bot.sendVideo(targetId, msg.video.file_id, { caption: prefix + (msg.caption || ""), parse_mode: "Markdown" });
    } else if (msg.text && !msg.text.startsWith("/")) {
      await bot.sendMessage(targetId, prefix + msg.text, { parse_mode: "Markdown", reply_markup: statusKb() });
    }

    userSessions[targetId] = userSessions[targetId] || { step: "idle", data: {} };
    userSessions[targetId].step = "can_reply_admin";
    await bot.sendMessage(chatId, `✅ Rejection sent to user ${targetId}.`);
    sess.step = "idle";
    return;
  }

  // ── User replying to admin ──
  if (sess.step === "can_reply_admin" && !msg.location && !msg.contact) {
    const prefix = `📨 *Reply from* ${msg.from.first_name || "User"} (ID: \`${chatId}\`):\n`;
    if (msg.photo) {
      const fid = msg.photo[msg.photo.length - 1].file_id;
      await bot.sendPhoto(ADMIN_CHAT_ID, fid, { caption: prefix + (msg.caption || ""), parse_mode: "Markdown" });
    } else if (msg.video) {
      await bot.sendVideo(ADMIN_CHAT_ID, msg.video.file_id, { caption: prefix + (msg.caption || ""), parse_mode: "Markdown" });
    } else if (msg.text && !msg.text.startsWith("/")) {
      await bot.sendMessage(ADMIN_CHAT_ID, prefix + msg.text, { parse_mode: "Markdown" });
    }
    return bot.sendMessage(chatId, "📤 Your message has been sent to the admin.");
  }

  // ── Location ──
  if (msg.location && sess.step === "awaiting_location") {
    sess.data.location = msg.location;
    sess.step = "awaiting_contact";
    return bot.sendMessage(
      chatId,
      `✅ Location received!\n\n📱 *Share your phone number* to register — click the button below.`,
      { parse_mode: "Markdown", reply_markup: contactKb() }
    );
  }

  // ── Contact ──
  if (msg.contact && sess.step === "awaiting_contact") {
    sess.data.phone = msg.contact.phone_number;
    sess.step = "awaiting_name";
    return bot.sendMessage(
      chatId,
      `✅ Phone received!\n\n` +
        `✌️ *Enter your real first and last name* as it appears on your ID:\n\n` +
        `• 2–4 words\n` +
        `• English, Russian or French (no numbers, not ALL CAPS)\n` +
        `• Hyphens, apostrophes and periods allowed\n` +
        `• Maximum 40 characters\n\n` +
        `_Example: John Michael Smith_`,
      { parse_mode: "Markdown", reply_markup: removeKb() }
    );
  }

  // ── Name ──
  if (sess.step === "awaiting_name" && msg.text && !msg.text.startsWith("/")) {
    if (!isValidName(msg.text)) {
      return bot.sendMessage(
        chatId,
        `⚠️ *Name format is incorrect.*\n\n` +
          `Please make sure:\n` +
          `• 2–4 words\n` +
          `• English, Russian or French letters only\n` +
          `• No numbers or ALL CAPS\n` +
          `• Max 40 characters\n\n` +
          `Try again:`,
        { parse_mode: "Markdown" }
      );
    }
    sess.data.fullName = msg.text.trim();
    sess.step = "awaiting_currency";
    return bot.sendMessage(
      chatId,
      `✅ Name saved!\n\n💱 *In which currency would you like to operate?*\n\n_USD is shown by default for all users._`,
      { parse_mode: "Markdown", reply_markup: currencyKb() }
    );
  }

  // ── ID Photos ──
  if (msg.photo && sess.step === "awaiting_id_photo") {
    if (!sess.data.idPhotos) sess.data.idPhotos = [];
    const fid = msg.photo[msg.photo.length - 1].file_id;
    sess.data.idPhotos.push(fid);
    const count = sess.data.idPhotos.length;

    return bot.sendMessage(
      chatId,
      `✅ Photo ${count} received!\n\nSend another photo OR click *Done* when finished.`,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "✅ Done — No more photos", callback_data: "photos_done" }]] },
      }
    );
  }

  // ── Street ──
  if (sess.step === "awaiting_street" && msg.text && !msg.text.startsWith("/")) {
    if (msg.text.trim().length < 3) {
      return bot.sendMessage(chatId, "⚠️ Street name is too short. Please enter a valid street name.");
    }
    sess.data.street = msg.text.trim();
    sess.step = "awaiting_topup";
    return bot.sendMessage(
      chatId,
      `✅ Street saved!\n\n` +
        `💰 *How would you like to top up your account?*\n\n` +
        `Choose the option that works best for you:`,
      { parse_mode: "Markdown", reply_markup: topupKb() }
    );
  }

  // ── Player ID ──
  if (sess.step === "awaiting_player_id" && msg.text && !msg.text.startsWith("/")) {
    const pid = msg.text.trim();
    if (!isValidPlayerId(pid)) {
      return bot.sendMessage(
        chatId,
        `⚠️ *Please recheck your Player ID.*\n\n` +
          `It must be a number between 9 and 11 digits (no letters).\n\n` +
          `Please send the correct number:`,
        { parse_mode: "Markdown" }
      );
    }
    sess.data.playerId = pid;
    sess.step = "completed";

    // Notify admin
    await notifyAdmin(chatId, { ...sess.data });

    return bot.sendMessage(
      chatId,
      `🎉 *Application submitted successfully!*\n\n` +
        `Thank you, *${sess.data.fullName}*!\n\n` +
        `Our team will review your application and get back to you shortly.\n\n` +
        `You can check your status anytime using the button below or the /status command.`,
      { parse_mode: "Markdown", reply_markup: statusKb() }
    );
  }
});

// ─── Admin Web Routes ──────────────────────────────────────────────────────

// Login page
app.get("/login", (req, res) => {
  if (req.session.admin) return res.redirect("/dashboard");
  res.sendFile(path.join(__dirname, "admin/public/login.html"));
});

// Login POST
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const validUser = username === (process.env.ADMIN_USERNAME || "admin");
  const validPass = password === (process.env.ADMIN_PASSWORD || "admin123");
  if (validUser && validPass) {
    req.session.admin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, message: "Invalid credentials" });
});

// Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Dashboard
app.get("/dashboard", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin/public/dashboard.html"));
});

// Root redirect
app.get("/", (req, res) => {
  res.redirect(req.session.admin ? "/dashboard" : "/login");
});

// API: Get all applications
app.get("/api/applications", requireAuth, (req, res) => {
  const list = Object.values(applications).sort(
    (a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)
  );
  res.json(list);
});

// API: Get single application
app.get("/api/applications/:chatId", requireAuth, (req, res) => {
  const app = applications[req.params.chatId];
  if (!app) return res.status(404).json({ error: "Not found" });
  res.json(app);
});

// API: Approve
app.post("/api/applications/:chatId/approve", requireAuth, async (req, res) => {
  const { chatId } = req.params;
  const app = applications[chatId];
  if (!app) return res.status(404).json({ error: "Not found" });

  applications[chatId].status = "approved";
  applications[chatId].approvedAt = new Date().toISOString();

  await bot.sendMessage(
    chatId,
    `🎉 *Congratulations!* Your MobCash agent application has been *APPROVED!*\n\nOur manager will contact you shortly. Welcome to the team! 🚀`,
    { parse_mode: "Markdown", reply_markup: statusKb() }
  ).catch(console.error);

  res.json({ success: true });
});

// API: Reject with message
app.post("/api/applications/:chatId/reject", requireAuth, async (req, res) => {
  const { chatId } = req.params;
  const { message } = req.body;
  const app = applications[chatId];
  if (!app) return res.status(404).json({ error: "Not found" });

  applications[chatId].status = "rejected";
  applications[chatId].rejectedAt = new Date().toISOString();
  applications[chatId].rejectReason = message;

  const text =
    `❌ *Your MobCash agent application has been rejected.*\n\n` +
    `📝 *Admin message:*\n${message || "No reason provided."}`;

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: statusKb() }).catch(console.error);

  // Enable user to reply
  userSessions[chatId] = userSessions[chatId] || { step: "idle", data: {} };
  userSessions[chatId].step = "can_reply_admin";

  res.json({ success: true });
});

// API: Send custom message to user
app.post("/api/applications/:chatId/message", requireAuth, async (req, res) => {
  const { chatId } = req.params;
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  await bot.sendMessage(chatId, `📬 *Message from MobCash Admin:*\n\n${message}`, { parse_mode: "Markdown" }).catch(console.error);

  if (!applications[chatId]) applications[chatId] = { chatId, adminMessages: [] };
  if (!applications[chatId].adminMessages) applications[chatId].adminMessages = [];
  applications[chatId].adminMessages.push({ from: "admin", text: message, at: new Date().toISOString() });

  res.json({ success: true });
});

// API: Stats
app.get("/api/stats", requireAuth, (req, res) => {
  const all = Object.values(applications);
  res.json({
    total: all.length,
    pending: all.filter((a) => a.status === "pending").length,
    approved: all.filter((a) => a.status === "approved").length,
    rejected: all.filter((a) => a.status === "rejected").length,
  });
});

// ─── Start Server ──────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ MobCash server running on port ${PORT}`);

  if (IS_PROD && APP_URL) {
    try {
      await bot.setWebHook(`${APP_URL}/webhook/${TOKEN}`);
      console.log(`✅ Webhook set: ${APP_URL}/webhook/${TOKEN}`);
    } catch (e) {
      console.error("❌ Webhook error:", e.message);
    }
  } else {
    console.log("🤖 Bot running in polling mode (development)");
  }
});
