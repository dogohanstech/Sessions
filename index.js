import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_DIR = path.resolve(process.env.SESSION_DIR || path.join(__dirname, "sessions"));
const sessions = new Map();
const logger = pino({ level: process.env.LOG_LEVEL || "silent" });

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public"), {
  dotfiles: "deny",
  index: "index.html"
}));

await fs.mkdir(SESSION_DIR, { recursive: true });

function makeId() {
  return `hansxmd_${crypto.randomBytes(4).toString("hex")}`;
}

function normalizePhone(input) {
  return String(input || "").replace(/\D/g, "");
}

function publicSession(record) {
  return {
    id: record.id,
    status: record.status,
    qr: record.qr || null,
    code: record.code || null,
    message: record.message || ""
  };
}

async function startSession({ phone = "" } = {}) {
  const id = makeId();
  const authDir = path.join(SESSION_DIR, id);
  await fs.mkdir(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const record = {
    id, authDir, status: "starting", qr: null, code: null,
    message: "Starting WhatsApp connection", socket: null, saveCreds,
    createdAt: Date.now()
  };

  const socket = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["HansXmd", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  record.socket = socket;
  sessions.set(id, record);

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", async (update) => {
    if (update.qr) {
      try {
        record.qr = await QRCode.toDataURL(update.qr);
        record.status = "waiting_for_scan";
        record.message = "Scan the QR code using WhatsApp Linked Devices.";
      } catch {
        record.status = "error";
        record.message = "Could not generate the QR code.";
      }
    }

    if (update.connection === "open") {
      record.status = "connected";
      record.qr = null;
      record.message = "WhatsApp connected.";
    }

    if (update.connection === "close") {
      record.qr = null;
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        record.status = "logged_out";
        record.message = "WhatsApp logged out. Create a new session.";
        sessions.delete(id);
      } else {
        record.status = "closed";
        record.message = "Connection closed. Create a new session to try again.";
      }
    }
  });

  if (phone) {
    // Pairing codes are requested only after the socket has been initialized.
    try {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (!state.creds.registered) {
        record.code = await socket.requestPairingCode(phone);
        record.status = "waiting_for_pairing";
        record.message = "Enter this code in WhatsApp Linked Devices.";
      } else {
        record.status = "connected";
        record.message = "This auth directory is already registered.";
      }
    } catch (error) {
      record.status = "error";
      record.message = error?.message || "Could not request a pairing code.";
    }
  }

  return record;
}

// Lightweight per-IP request throttle to reduce accidental or automated abuse.
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
  if (current.count > 12) {
    return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/session/qr", async (_req, res) => {
  try {
    const record = await startSession();
    res.status(201).json(publicSession(record));
  } catch (error) {
    res.status(500).json({ error: error?.message || "Could not start a session." });
  }
});

app.post("/api/session/pairing", async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({ error: "Enter a valid phone number including the country code, digits only." });
  }
  try {
    const record = await startSession({ phone });
    if (record.status === "error") {
      return res.status(502).json({ error: record.message });
    }
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

// Deliberately do not expose /sessions, creds.json, or any auth-state files over HTTP.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`HansXmd Session Generator listening on port ${PORT}`);
});
