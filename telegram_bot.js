import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import path from "path";
import readline from "readline";
import botBridge from "./whatsapp_bot.js"; // keep bridge intact

// -----------------------
// CONFIG
// -----------------------
const CONFIG_PATH = path.join(process.cwd(), "config.json");
let BOT_CONFIG = {};

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    BOT_CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH));
  } else {
    BOT_CONFIG = {
      bot_token: "",
      admin_id: "",
      users: {},
      passkeys: {},
      notify_admin_on_access_attempt: true,
      passkey_length: 6
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(BOT_CONFIG, null, 2));
  }
  return BOT_CONFIG;
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(BOT_CONFIG, null, 2));
}

function generatePasskey(length = BOT_CONFIG.passkey_length) {
  let key = "";
  for (let i = 0; i < length; i++) key += Math.floor(Math.random() * 10);
  return key;
}

// -----------------------
// TOKEN HANDLING
// -----------------------
async function getBotToken() {
  if (process.env.BOT_TOKEN) return process.env.BOT_TOKEN;
  if (BOT_CONFIG.bot_token?.trim()) return BOT_CONFIG.bot_token;

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Enter your Telegram bot token: ", (answer) => {
      BOT_CONFIG.bot_token = answer.trim();
      saveConfig();
      rl.close();
      resolve(BOT_CONFIG.bot_token);
    });
  });
}

// -----------------------
// BOT INIT
// -----------------------
BOT_CONFIG = loadConfig();

const bot = new TelegramBot(await getBotToken(), { polling: true });

// -----------------------
// USER COMMANDS
// -----------------------
bot.onText(/\/start/, (msg) => {
  const userId = String(msg.from.id);
  if (!BOT_CONFIG.users[userId]) {
    bot.sendMessage(msg.chat.id, "You are not registered. Request access from the admin.");
    if (BOT_CONFIG.notify_admin_on_access_attempt)
      bot.sendMessage(BOT_CONFIG.admin_id, `User ${userId} attempted access.`);
    return;
  }
  bot.sendMessage(msg.chat.id, "Welcome! You can link/unlink WhatsApp numbers and review deleted messages.");
});

bot.onText(/\/request_passkey/, (msg) => {
  const userId = String(msg.from.id);
  if (!BOT_CONFIG.users[userId]) {
    const key = generatePasskey();
    BOT_CONFIG.passkeys[key] = userId;
    saveConfig();
    bot.sendMessage(BOT_CONFIG.admin_id, `User ${userId} requested access. Passkey: ${key}`);
    bot.sendMessage(msg.chat.id, "Request sent to admin. Await passkey.");
  }
});

bot.onText(/\/verify (.+)/, (msg, match) => {
  const userId = String(msg.from.id);
  const key = match[1];
  if (BOT_CONFIG.passkeys[key] === userId) {
    BOT_CONFIG.users[userId] = { active: true, numbers: [], deleted_messages: [] };
    delete BOT_CONFIG.passkeys[key];
    saveConfig();
    bot.sendMessage(msg.chat.id, "✅ Access granted!");
  } else {
    bot.sendMessage(msg.chat.id, "❌ Invalid or expired passkey!");
  }
});

// -----------------------
// LINK / UNLINK
// -----------------------
bot.onText(/\/link (.+)/, (msg, match) => {
  const userId = String(msg.from.id);
  if (!BOT_CONFIG.users[userId]) return bot.sendMessage(msg.chat.id, "You are not authorized.");

  const number = match[1];
  bot.sendMessage(msg.chat.id, `Choose how to link WhatsApp number *${number}*:`, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📷 QR Code", callback_data: `link_qr_${number}` },
          { text: "📱 Phone Number", callback_data: `link_num_${number}` },
          { text: "❌ Unlink", callback_data: `unlink_${number}` }
        ]
      ]
    }
  });
});

bot.on("callback_query", async (query) => {
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;
  const data = query.data;

  if (!BOT_CONFIG.users[userId]) return bot.sendMessage(chatId, "You are not authorized.");

  if (data.startsWith("link_qr_") || data.startsWith("link_num_") || data.startsWith("unlink_")) {
    const number = data.split("_")[2];
    const method = data.startsWith("link_qr_") ? "qr" : data.startsWith("link_num_") ? "phone" : null;

    if (method) {
      bot.emit("link_whatsapp", { userId, number, method });
      bot.sendMessage(chatId, `🔗 Processing WhatsApp ${method === "qr" ? "QR" : "Phone"} linking for ${number}...`);
    } else {
      bot.emit("unlink_whatsapp", { userId, number });
      bot.sendMessage(chatId, `❌ Unlinking WhatsApp number ${number}...`);
    }
  }

  if (data.startsWith("keep_") || data.startsWith("delete_")) {
    const userData = BOT_CONFIG.users[userId];
    if (!userData || !userData.deleted_messages) return;

    const msgId = data.split("_")[1];
    if (data.startsWith("keep_")) userData.deleted_messages = userData.deleted_messages.filter(m => m.id !== msgId);
    else userData.deleted_messages = userData.deleted_messages.filter(m => m.id !== msgId);

    bot.sendMessage(chatId, data.startsWith("keep_") ? "✅ Message restored." : "🗑 Message deleted permanently.");
    saveConfig();
  }

  bot.answerCallbackQuery(query.id);
});

// -----------------------
// DELETED MESSAGES
// -----------------------
bot.onText(/\/deleted_messages/, (msg) => {
  const userId = String(msg.from.id);
  if (!BOT_CONFIG.users[userId]) return bot.sendMessage(msg.chat.id, "You are not authorized.");

  const deleted = BOT_CONFIG.users[userId].deleted_messages || [];
  if (!deleted.length) return bot.sendMessage(msg.chat.id, "No deleted messages.");

  deleted.forEach((m, idx) => {
    const text = `Message ${idx + 1} to ${m.to}:\n${m.body || "[Media/Unknown]"}`;
    bot.sendMessage(msg.chat.id, text, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Keep", callback_data: `keep_${m.id}` }],
          [{ text: "🗑 Delete permanently", callback_data: `delete_${m.id}` }]
        ]
      }
    });
  });
});

// -----------------------
// ADMIN COMMANDS
// -----------------------
const adminCheck = (id) => String(id) === String(BOT_CONFIG.admin_id);

bot.onText(/\/add_user (.+)/, (msg, match) => {
  if (!adminCheck(msg.from.id)) return;
  const newUser = String(match[1]);
  BOT_CONFIG.users[newUser] = { active: false, numbers: [], deleted_messages: [] };
  saveConfig();
  bot.sendMessage(msg.chat.id, `User ${newUser} added successfully.`);
});

bot.onText(/\/remove_user (.+)/, (msg, match) => {
  if (!adminCheck(msg.from.id)) return;
  const target = String(match[1]);
  delete BOT_CONFIG.users[target];
  saveConfig();
  bot.sendMessage(msg.chat.id, `User ${target} removed successfully.`);
});

bot.onText(/\/view_user (.+)/, (msg, match) => {
  if (!adminCheck(msg.from.id)) return;
  const target = String(match[1]);
  bot.sendMessage(msg.chat.id, BOT_CONFIG.users[target] ? JSON.stringify(BOT_CONFIG.users[target], null, 2) : "User not found.");
});

bot.onText(/\/list_users/, (msg) => {
  if (!adminCheck(msg.from.id)) return;
  const list = Object.entries(BOT_CONFIG.users)
    .map(([uid, data]) => `${uid}: ${JSON.stringify(data)}`)
    .join("\n");
  bot.sendMessage(msg.chat.id, list || "No users found.");
});

console.log("Telegram bot running...");

export default bot;