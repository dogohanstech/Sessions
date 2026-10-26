import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
  delay
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { upload as megaUpload, megaConfigured } from "./mega.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_DIR = path.resolve(process.env.SESSION_DIR || path.join(__dirname, "sessions"));
const sessions = new Map();
const logger = pino({ level: process.env.LOG_LEVEL || "silent" });

const MAX_RECONNECTS = 6;
const PAIRING_WAIT_MS = 30_000;
const UNFINISHED_TTL_MS = 10 * 60_000;
const FINISHED_TTL_MS = 60 * 60_000;

app.set("trust proxy", 1); // Render sits behind a proxy
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public"), { dotfiles: "deny", index: "index.html" }));

await fs.mkdir(SESSION_DIR, { recursive: true });

process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err?.message || err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err?.message || err));

const makeId = () => `hansxmd_${crypto.randomBytes(4).toString("hex")}`;
const normalizePhone = (input) => String(input || "").replace(/\D/g, "");

function publicSession(record) {
  return {
    id: record.id,
    status: record.status,
    qr: record.qr || null,
    code: record.code || null,
    message: record.message || ""
  };
}

function formatCode(code) {
  const raw = String(code || "").replace(/[^A-Za-z0-9]/g, "");
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : String(code || "");
}

async function openSocket(record) {
  const { state, saveCreds } = await useMultiFileAuthState(record.authDir);

  const socket = makeWASocket({
    auth: state,
    logger,
    // A standard browser descriptor is REQUIRED for pairing codes to work.
    browser: Browsers.ubuntu("Chrome"),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000
  });
  record.socket = socket;

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", async (update) => {
    if (record.socket !== socket || record.finished) return;
    const { connection, lastDisconnect, qr } = update;

    // `qr` fires once the WhatsApp handshake is ready, which is the safe moment
    // to request a pairing code (requesting too early causes "Couldn't link device").
    if (qr && !state.creds.registered) {
      if (record.phone) {
        if (!record.codeRequested) {
          record.codeRequested = true;
          try {
            console.log(`[${record.id}] requesting pairing code for ${record.phone.slice(0, 4)}***`);
            const code = await socket.requestPairingCode(record.phone);
            record.code = formatCode(code);
            record.status = "waiting_for_pairing";
            record.message = "Enter this code in WhatsApp > Linked Devices > Link with phone number. It expires in about 1 minute.";
            record.resolveCode?.();
          } catch (error) {
            console.log(`[${record.id}] pairing code error: ${error?.message}`);
            record.status = "error";
            record.message = error?.message || "Could not request a pairing code.";
            record.resolveCode?.();
          }
        }
      } else {
        try {
          record.qr = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
          record.status = "waiting_for_scan";
          record.message = "Scan the QR code using WhatsApp > Linked Devices > Link a device.";
          record.resolveCode?.();
        } catch {
          record.status = "error";
          record.message = "Could not generate the QR code.";
          record.resolveCode?.();
        }
      }
    }

    if (connection) console.log(`[${record.id}] connection: ${connection}`);
    if (connection === "open") {
      if (record.delivering || record.delivered) return;
      record.delivering = true;
      record.qr = null;
      record.code = null;
      record.reconnects = 0;
      record.connectedAt = Date.now();
      record.status = "uploading";
      record.message = "Linked! Creating your session ID…";
      record.resolveCode?.();
      deliverSession(record, socket).catch((error) => {
        console.log(`[${record.id}] deliver error: ${error?.message}`);
      });
    }

    if (connection === "close") {
      record.qr = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const paired = Boolean(socket.authState?.creds?.me);
      const reason = `${statusCode ?? "no-code"}: ${lastDisconnect?.error?.message || "unknown"}`;
      record.lastError = reason;
      console.log(`[${record.id}] connection closed (${reason}) paired=${paired} retries=${record.reconnects}`);

      if (statusCode === DisconnectReason.loggedOut) {
        record.status = "logged_out";
        record.message = "WhatsApp logged out. Create a new session.";
        record.finished = true;
        return;
      }

      // After a successful pair/scan WhatsApp ALWAYS closes with restartRequired (515)
      // and the client must reconnect with the saved creds to finish linking.
      const canRetry =
        statusCode === DisconnectReason.restartRequired ||
        (paired && statusCode !== DisconnectReason.badSession) ||
        (!record.phone && !paired); // QR mode: reconnect for a fresh QR

      if (canRetry && record.reconnects < MAX_RECONNECTS) {
        record.reconnects += 1;
        record.status = "reconnecting";
        record.message = paired
          ? "Finishing the link with WhatsApp…"
          : "Refreshing the QR code…";
        try { socket.ev.removeAllListeners("connection.update"); } catch {}
        setTimeout(() => {
          if (record.finished) return;
          openSocket(record).catch((error) => {
            record.status = "error";
            record.message = error?.message || "Reconnect failed.";
          });
        }, 1000);
        return;
      }

      record.status = "closed";
      record.message = paired
        ? "Connection closed. Create a new session to try again."
        : `Connection closed before linking finished (${record.lastError}). Generate a new code and enter it within 1 minute.`;
      record.finished = true;
      record.resolveCode?.();
    }
  });
}

const MESSAGE = [
  "*HANSXMD SESSION GENERATED* ✅",
  "",
  "Copy the session ID above and put it in your bot's SESSION_ID setting.",
  "⚠️ Never share it with anyone."
].join("\n");

async function sendWithRetry(socket, jid, content, tries = 4) {
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      return await socket.sendMessage(jid, content);
    } catch (error) {
      lastError = error;
      await delay(1500 * (i + 1));
    }
  }
  throw lastError;
}

// Uploads creds.json to MEGA and sends a short session ID to the linked account's own chat.
async function deliverSession(record, socket) {
  try {
    if (!megaConfigured()) {
      throw new Error("Server is missing MEGA_EMAIL / MEGA_PASSWORD. Set them and try again.");
    }

    await delay(3000); // let Baileys finish writing creds.json
    const credsFile = path.join(record.authDir, "creds.json");
    const creds = await fs.readFile(credsFile);

    record.message = "Uploading session to MEGA…";
    const fileName = `hansxmd_${crypto.randomBytes(4).toString("hex")}.json`;
    let link;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { link = await megaUpload(creds, fileName); break; }
      catch (error) {
        console.log(`[${record.id}] MEGA upload attempt ${attempt} failed: ${error?.message}`);
        if (attempt === 3) throw error;
        await delay(2000);
      }
    }

    // Short session ID: HansTz&<fileId>#<key>
    const sessionId = link.replace("https://mega.nz/file/", "HansTz&");

    const me = socket.authState?.creds?.me;
    const targets = [me?.id, me?.lid].filter(Boolean).map((j) => jidNormalizedUser(j));
    if (!targets.length) throw new Error("Could not find the linked account's WhatsApp ID.");

    record.message = "Sending session ID to your WhatsApp…";
    let sent = false, sendError;
    for (const jid of targets) {
      try {
        const msg = await sendWithRetry(socket, jid, { text: sessionId });
        await sendWithRetry(socket, jid, { text: MESSAGE }, 2).catch(() => {});
        void msg;
        sent = true;
        break;
      } catch (error) { sendError = error; }
    }
    if (!sent) throw sendError || new Error("Could not send the session ID to WhatsApp.");

    await delay(1500);
    record.delivered = true;
    record.status = "connected";
    record.message = "Linked! Your session ID was sent to your WhatsApp (Message yourself).";
    console.log(`[${record.id}] session delivered`);

    // Done: stop the socket and remove local credentials from the server.
    record.finished = true;
    try { socket.end(undefined); } catch {}
    setTimeout(() => fs.rm(record.authDir, { recursive: true, force: true }).catch(() => {}), 5000);
  } catch (error) {
    record.delivering = false;
    record.status = "error";
    record.message = `Linked, but session delivery failed: ${error?.message || error}`;
    record.finished = true; // keep auth files so nothing is lost
    try { socket.end(undefined); } catch {}
    throw error;
  }
}

async function startSession({ phone = "" } = {}) {
  const id = makeId();
  const authDir = path.join(SESSION_DIR, id);
  await fs.mkdir(authDir, { recursive: true });

  const record = {
    id, authDir, phone, status: "starting", qr: null, code: null,
    message: "Starting WhatsApp connection…", socket: null,
    codeRequested: false, reconnects: 0, finished: false,
    createdAt: Date.now(), connectedAt: null, resolveCode: null
  };
  sessions.set(id, record);

  const ready = new Promise((resolve) => { record.resolveCode = resolve; });
  await openSocket(record);

  // Wait until the code / QR exists (or an error happens) so the first response is useful.
  await Promise.race([ready, new Promise((r) => setTimeout(r, PAIRING_WAIT_MS))]);
  if (!record.code && !record.qr && record.status === "starting") {
    record.status = "error";
    record.message = "WhatsApp did not respond in time. Check the server's internet connection and try again.";
  }
  return record;
}

// Per-IP throttle
const requestCounts = new Map();
app.use("/api/session", (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const current = requestCounts.get(ip);
  if (!current || now - current.startedAt > 60_000) {
    requestCounts.set(ip, { startedAt: now, count: 1 });
    return next();
  }
  current.count += 1;
  if (current.count > 20) {
    return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/session/qr", async (_req, res) => {
  try {
    const record = await startSession();
    if (record.status === "error") return res.status(502).json({ error: record.message });
    res.status(201).json(publicSession(record));
  } catch (error) {
    res.status(500).json({ error: error?.message || "Could not start a session." });
  }
});

app.post("/api/session/pairing", async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({ error: "Enter a valid phone number including the country code, digits only (no + or leading 0)." });
  }
  try {
    const record = await startSession({ phone });
    if (record.status === "error") return res.status(502).json({ error: record.message });
    res.status(201).json(publicSession(record));
  } catch (error) {
    res.status(500).json({ error: error?.message || "Could not request a pairing code." });
  }
});

app.get("/api/session/:id", (req, res) => {
  const record = sessions.get(req.params.id);
  if (!record) return res.status(404).json({ error: "Session not found or server restarted. Create a new session." });
  res.json(publicSession(record));
});

// Cleanup stale sessions
setInterval(async () => {
  const now = Date.now();
  for (const [id, record] of sessions) {
    const connected = record.status === "connected";
    const age = now - record.createdAt;
    if ((!connected && age > UNFINISHED_TTL_MS) || (connected && now - record.connectedAt > FINISHED_TTL_MS)) {
      record.finished = true;
      try { record.socket?.end(undefined); } catch {}
      sessions.delete(id);
      if (!connected) await fs.rm(record.authDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}, 60_000).unref();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HansXmd Session Generator listening on port ${PORT}`);
});
