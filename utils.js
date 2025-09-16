// utils.js (memory-cached version)
import fs from "fs";
import path from "path";

// -----------------------
// CONFIG LOADING / SAVING
// -----------------------
let CONFIG = {};
let SESSIONS_CACHE = {};        // number -> sessionData
let DELETED_CACHE = {};         // number -> messages array

export function loadConfig(configPath = "./config.json") {
  if (fs.existsSync(configPath)) {
    CONFIG = JSON.parse(fs.readFileSync(configPath));
  } else {
    CONFIG = {
      users: {},
      passkeys: {},
      admin_id: "",
      bot_token: "",
      whatsapp_sessions_path: "./sessions/",
      deleted_messages_path: "./deleted_messages/",
      deleted_messages_limit: 1000,
      log_deleted_messages: true,
      log_user_activity: true,
      passkey_length: 6,
      check_interval: 0.1,
      notify_admin_on_access_attempt: true,
    };
    fs.writeFileSync(configPath, JSON.stringify(CONFIG, null, 2));
  }

  fs.mkdirSync(CONFIG.whatsapp_sessions_path, { recursive: true });
  fs.mkdirSync(CONFIG.deleted_messages_path, { recursive: true });

  // preload sessions
  const sessionFiles = fs.existsSync(CONFIG.whatsapp_sessions_path)
    ? fs.readdirSync(CONFIG.whatsapp_sessions_path).filter(f => f.endsWith(".json"))
    : [];
  sessionFiles.forEach(f => {
    const number = path.basename(f, ".json");
    SESSIONS_CACHE[number] = JSON.parse(fs.readFileSync(path.join(CONFIG.whatsapp_sessions_path, f), "utf-8"));
  });

  // preload deleted messages
  const delFiles = fs.existsSync(CONFIG.deleted_messages_path)
    ? fs.readdirSync(CONFIG.deleted_messages_path).filter(f => f.endsWith(".json"))
    : [];
  delFiles.forEach(f => {
    const number = path.basename(f, ".json");
    DELETED_CACHE[number] = JSON.parse(fs.readFileSync(path.join(CONFIG.deleted_messages_path, f), "utf-8"));
  });

  return CONFIG;
}

export function saveConfig(config = null, configPath = "./config.json") {
  if (config) CONFIG = config;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(CONFIG, null, 2));
}

// -----------------------
// USER MANAGEMENT
// -----------------------
export function getUser(userId) {
  return CONFIG.users[String(userId)];
}

export async function addUser(userId) {
  userId = String(userId);
  if (CONFIG.users[userId]) return false;
  CONFIG.users[userId] = { numbers: [], activity_log: [], active: false };
  saveConfig();
  return true;
}

export async function removeUser(userId) {
  const removed = CONFIG.users[String(userId)];
  delete CONFIG.users[String(userId)];
  saveConfig();
  return removed;
}

export async function logUserActivity(userId, message) {
  if (!CONFIG.log_user_activity) return;
  const user = getUser(userId);
  if (user) {
    const timestamp = new Date().toISOString();
    user.activity_log.push({ time: timestamp, message });
    saveConfig();
  }
}

// -----------------------
// PASSKEY MANAGEMENT
// -----------------------
export function generatePasskey(length = CONFIG.passkey_length) {
  let result = "";
  for (let i = 0; i < length; i++) result += Math.floor(Math.random() * 10);
  return result;
}

export async function assignPasskey(userId) {
  const key = generatePasskey();
  CONFIG.passkeys[key] = String(userId);
  saveConfig();
  return key;
}

export async function validatePasskey(userId, key) {
  const validUser = CONFIG.passkeys[key];
  if (!validUser || String(userId) !== String(validUser)) return false;
  delete CONFIG.passkeys[key];
  saveConfig();
  return true;
}

// -----------------------
// WHATSAPP SESSION MANAGEMENT
// -----------------------
export async function saveWhatsAppSession(number, sessionData) {
  SESSIONS_CACHE[number] = sessionData;
  const filePath = path.join(CONFIG.whatsapp_sessions_path, `${number}.json`);
  fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2));
}

export async function loadWhatsAppSession(number) {
  return SESSIONS_CACHE[number] || null;
}

export function listWhatsAppSessions() {
  return Object.keys(SESSIONS_CACHE);
}

// -----------------------
// DELETED MESSAGES HANDLING
// -----------------------
export async function saveDeletedMessage(number, message) {
  if (!CONFIG.log_deleted_messages) return;
  if (!DELETED_CACHE[number]) DELETED_CACHE[number] = [];
  DELETED_CACHE[number].push({ time: new Date().toISOString(), message });

  // enforce limit
  if (DELETED_CACHE[number].length > CONFIG.deleted_messages_limit) {
    DELETED_CACHE[number] = DELETED_CACHE[number].slice(-CONFIG.deleted_messages_limit);
  }

  const filePath = path.join(CONFIG.deleted_messages_path, `${number}.json`);
  fs.writeFileSync(filePath, JSON.stringify(DELETED_CACHE[number], null, 2));
}

export async function loadDeletedMessages(number) {
  return DELETED_CACHE[number] || [];
}

export async function clearDeletedMessages(number) {
  DELETED_CACHE[number] = [];
  const filePath = path.join(CONFIG.deleted_messages_path, `${number}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}