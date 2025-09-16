// whatsapp_bot.js
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import P from "pino";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";

import bot from "./telegram_bot.js";
import {
  loadConfig,
  saveWhatsAppSession,
  loadWhatsAppSession,
  saveDeletedMessage,
} from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let BOT_CONFIG = loadConfig();

// -----------------------
// TELEGRAM NOTIFY HELPER
// -----------------------
async function notifyUser(userId, text, imgBuffer = null) {
  try {
    if (imgBuffer) {
      await bot.sendPhoto(userId, imgBuffer, { caption: text, parse_mode: "Markdown" });
    } else {
      await bot.sendMessage(userId, text, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error(`[Notify] Failed to notify user ${userId}:`, err.message);
  }
}

// -----------------------
// WHATSAPP MANAGER
// -----------------------
class WhatsAppManager {
  static activeSessions = {};

  static async startSession(userId, number, method = "qr") {
    userId = String(userId);
    number = String(number);

    if (!this.activeSessions[userId]) this.activeSessions[userId] = {};
    if (this.activeSessions[userId][number]) return;

    const sessionsDir = path.resolve(BOT_CONFIG.whatsapp_sessions_path || "./sessions");
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

    const authDir = path.join(sessionsDir, number);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      printQRInTerminal: true,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" })),
      },
      logger: P({ level: "silent" }),
    });

    sock.ev.on("creds.update", saveCreds);

    // -----------------------
    // CONNECTION UPDATES
    // -----------------------
    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, pairingCode } = update;

      if (method === "qr" && qr) {
        try {
          const qrBuffer = await QRCode.toBuffer(qr, { type: "png" });
          await notifyUser(userId, `Scan this QR to link WhatsApp (${number})`, qrBuffer);
        } catch (err) {
          console.error("[WhatsAppManager] QR generation error:", err);
        }
      }

      if (method === "phone" && pairingCode) {
        await notifyUser(userId, `Your pairing code for WhatsApp (${number}): *${pairingCode}*`);
      }

      if (connection === "close") {
        console.log(`[WhatsAppManager] Connection closed for ${number}`);
        delete this.activeSessions[userId][number];
        await notifyUser(userId, `❌ WhatsApp session closed for ${number}`);
      } else if (connection === "open") {
        console.log(`[WhatsAppManager] Connected: ${number}`);
        await notifyUser(userId, `✅ WhatsApp connected successfully: ${number}`);
      }
    });

    // -----------------------
    // OUTGOING MESSAGE WATCHER
    // -----------------------
    const watchOutgoing = async (m) => {
      const messages = m.messages || [];
      for (const msg of messages) {
        if (!msg.message || !msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid;

        if (BOT_CONFIG.auto_delete) {
          try {
            await sock.sendMessage(remoteJid, { delete: msg.key });
            saveDeletedMessage(number, msg);
            await notifyUser(userId, `🗑 Outgoing message to ${remoteJid} auto-deleted.`);
          } catch (err) {
            console.error(`[WhatsAppManager] Failed to delete outgoing message (${number}):`, err);
          }
        }
      }
    };

    sock.ev.on("messages.upsert", watchOutgoing);

    // -----------------------
    // SAVE SESSION INFO
    // -----------------------
    const sessionData = loadWhatsAppSession(number) || {
      linked_to: userId,
      number,
      status: "active",
      messages_deleted: 0,
    };
    saveWhatsAppSession(number, sessionData);

    this.activeSessions[userId][number] = sock;
    return sock;
  }

  static async stopSession(userId, number) {
    userId = String(userId);
    number = String(number);

    if (this.activeSessions[userId]?.[number]) {
      try {
        await this.activeSessions[userId][number].logout();
        await notifyUser(userId, `⚠️ WhatsApp session unlinked for ${number}`);
      } catch (err) {
        console.error(`[WhatsAppManager] Error logging out ${number}:`, err);
      }
      delete this.activeSessions[userId][number];
    }
  }

  static listActiveSessions(userId = null) {
    return userId ? this.activeSessions[String(userId)] || {} : this.activeSessions;
  }

  static watchAllSessions() {
    for (const [userId, numbers] of Object.entries(this.activeSessions)) {
      for (const [number, sock] of Object.entries(numbers)) {
        sock.ev.on("messages.upsert", async (m) => {
          await WhatsAppManager.startSession(userId, number); // Ensure always active
        });
      }
    }
  }
}

// -----------------------
// START / RUN
// -----------------------
export async function startAllSessions() {
  BOT_CONFIG = loadConfig();
  for (const [userId, data] of Object.entries(BOT_CONFIG.users)) {
    const numbers = data.numbers || [];
    for (const number of numbers) {
      await WhatsAppManager.startSession(userId, number);
    }
  }
  WhatsAppManager.watchAllSessions();
}

export async function runWhatsAppBot() {
  await startAllSessions();
  console.log("[WhatsAppManager] WhatsApp bot running...");
  setInterval(() => {}, 1000);
}

export { WhatsAppManager };

// -----------------------
// TELEGRAM EVENTS BRIDGE
// -----------------------
bot.on("link_whatsapp", async ({ userId, number, method }) => {
  await WhatsAppManager.startSession(userId, number, method);
});

bot.on("unlink_whatsapp", async ({ userId, number }) => {
  await WhatsAppManager.stopSession(userId, number);
});