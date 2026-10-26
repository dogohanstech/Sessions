
import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const SESSION_DIR = path.resolve("sessions");
const sessions = new Map();

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "HansXmd Session Generator" });
});

// Protect session-management endpoints with a secret token.
app.use("/api", (req, res, next) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      error: "Set ADMIN_TOKEN in your deployment environment."
    });
  }

  const supplied = req.get("x-admin-token") || "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_TOKEN);

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

function createSessionId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(8);
  const suffix = [...bytes]
    .map((byte) => chars[byte % chars.length])
    .join("");

  return `hansxmd_${suffix}`;
}

function normalizePhone(value) {
  const phone = String(value || "").replace(/\D/g, "");

  if (phone.length < 8 || phone.length > 15) {
    throw new Error(
      "Enter a valid phone number with country code, e.g. 255XXXXXXXXX."
    );
  }

  return phone;
}

async function startSession(sessionId) {
  const authDir = path.join(SESSION_DIR, sessionId);
  await fs.mkdir(authDir, { recursive: true });

  const { state, saveCreds } =
    await useMultiFileAuthState(authDir);

  const record = {
    id: sessionId,
    status: "connecting",
    qr: null,
    pairingCode: null,
    error: null,
    socket: null,
    createdAt: new Date().toISOString()
  };

  sessions.set(sessionId, record);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["HansXmd", "Chrome", "1.0.0"]
  });

  record.socket = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    if (update.qr) {
      record.qr = await QRCode.toDataURL(update.qr)
        .catch(() => null);
      record.status = "awaiting_scan";
    }

    if (update.connection === "open") {
      record.status = "connected";
      record.qr = null;
      record.pairingCode = null;
    }

    if (update.connection === "close") {
      record.status = "disconnected";
      record.qr = null;

      const statusCode =
        update.lastDisconnect?.error?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        record.error = "Logged out. Start a new session.";
      }
    }
  });

  return record;
}

// Start a session and obtain a QR code to scan.
app.post("/api/session/qr", async (_req, res) => {
  try {
    const id = createSessionId();
    const record = await startSession(id);

    res.status(201).json({
      sessionId: id,
      status: record.status,
      message: "Scan the QR code using WhatsApp Linked Devices."
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start a session and request a phone-number pairing code.
app.post("/api/session/pairing", async (req, res) => {
  let record;

  try {
    const phone = normalizePhone(req.body?.phone);
    const id = createSessionId();

    record = await startSession(id);

    if (record.socket.authState?.creds?.registered) {
      return res.status(409).json({
        error: "This session is already registered."
      });
    }

    const code = await record.socket.requestPairingCode(phone);

    record.pairingCode = code;

    res.status(201).json({
      sessionId: id,
      pairingCode: code,
      status: record.status,
      message: "Enter this code in WhatsApp Linked Devices."
    });
  } catch (error) {
    if (record) {
      record.error = error.message;
    }

    res.status(400).json({ error: error.message });
  }
});

// Read session status without revealing credentials.
app.get("/api/session/:id/status", (req, res) => {
  const record = sessions.get(req.params.id);

  if (!record) {
    return res.status(404).json({ error: "Session not found." });
  }

  res.json({
    sessionId: record.id,
    status: record.status,
    createdAt: record.createdAt,
    error: record.error
  });
});

// Retrieve the QR image for an existing session.
app.get("/api/session/:id/qr", (req, res) => {
  const record = sessions.get(req.params.id);

  if (!record) {
    return res.status(404).json({ error: "Session not found." });
  }

  if (!record.qr) {
    return res.status(404).json({
      error: "QR code is not currently available."
    });
  }

  res.json({ qr: record.qr });
});

// Never return creds.json or authentication keys from an API.
app.use((err, _req, res, _next) => {
  console.error("Request error:", err.message);
  res.status(500).json({ error: "Internal server error." });
});

await fs.mkdir(SESSION_DIR, { recursive: true });

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HansXmd server running on port ${PORT}`);
});
