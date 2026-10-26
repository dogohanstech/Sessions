
"use strict";

const $ = (selector) => document.querySelector(selector);

const state = {
  sessionId: null,
  pollTimer: null,
};

function setMessage(message, type = "info") {
  const output = $("#message");
  if (!output) return;

  output.textContent = message;
  output.dataset.type = type;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || `Request failed (${response.status})`);
  }

  return result;
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function showSessionId(id) {
  const element = $("#sessionId");
  if (element) element.textContent = id || "Not created";
}

function showPairingCode(code) {
  const element = $("#pairingCode");
  if (element) element.textContent = code || "—";
}

function showQr(dataUrl) {
  const image = $("#qrImage");
  if (!image) return;

  if (dataUrl) {
    image.src = dataUrl;
    image.hidden = false;
  } else {
    image.removeAttribute("src");
    image.hidden = true;
  }
}

function showStatus(status) {
  const element = $("#connectionStatus");
  if (!element) return;

  element.textContent = status || "Unknown";
  element.classList.toggle("online", status === "connected");
  element.classList.toggle("error", status === "error");
}

async function createSession(mode) {
  stopPolling();
  state.sessionId = null;

  showSessionId(null);
  showPairingCode(null);
  showQr(null);
  showStatus("starting");
  setMessage("Creating a new session…");

  try {
    const result = await apiRequest(
      mode === "pairing" ? "/api/session/pairing" : "/api/session/qr",
      {
        method: "POST",
        body: JSON.stringify(
          mode === "pairing"
            ? { phone: $("#phoneNumber")?.value?.trim() || "" }
            : {}
        ),
      }
    );

    state.sessionId = result.id;
    showSessionId(result.id);

    if (result.code) showPairingCode(result.code);
    if (result.qr) showQr(result.qr);

    setMessage(
      mode === "pairing"
        ? "Pairing code requested. Follow the instructions on your phone."
        : "QR session created. Scan the QR code using WhatsApp.",
      "success"
    );

    await refreshStatus();
    state.pollTimer = setInterval(refreshStatus, 3000);
  } catch (error) {
    showStatus("error");
    setMessage(error.message, "error");
  }
}

async function refreshStatus() {
  if (!state.sessionId) return;

  try {
    const result = await apiRequest(
      `/api/session/${encodeURIComponent(state.sessionId)}`
    );

    showStatus(result.status);

    if (result.qr) showQr(result.qr);
    if (result.code) showPairingCode(result.code);

    if (result.status === "connected") {
      setMessage("WhatsApp connected. Keep your session credentials private.", "success");
      stopPolling();
    } else if (result.status === "error" || result.status === "closed") {
      setMessage("The session is no longer active. Create a new session if needed.", "error");
      stopPolling();
    }
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function copyText(selector) {
  const value = $(selector)?.textContent?.trim();

  if (!value || value === "—" || value === "Not created") {
    setMessage("There is nothing to copy yet.", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    setMessage("Copied to clipboard.", "success");
  } catch {
    setMessage("Clipboard access failed. Select and copy the text manually.", "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("#pairingButton")?.addEventListener("click", () => createSession("pairing"));
  $("#qrButton")?.addEventListener("click", () => createSession("qr"));
  $("#copyCodeButton")?.addEventListener("click", () => copyText("#pairingCode"));
  $("#refreshButton")?.addEventListener("click", refreshStatus);
  $("#stopButton")?.addEventListener("click", () => {
    stopPolling();
    setMessage("Status refresh paused. This does not disconnect WhatsApp.");
  });
});
