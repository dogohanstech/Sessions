"use strict";

const $ = (selector) => document.querySelector(selector);
const state = { sessionId: null, pollTimer: null };

function setMessage(message, type = "info") {
  const output = $("#message");
  if (!output) return;
  output.textContent = message;
  output.dataset.type = type;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function showStatus(status) {
  const el = $("#connectionStatus");
  el.textContent = status || "unknown";
  el.classList.toggle("online", status === "connected");
  el.classList.toggle("error", ["error", "closed", "logged_out"].includes(status));
}

function showQr(qr) {
  const image = $("#qrImage");
  image.hidden = !qr;
  if (qr) image.src = qr;
  else image.removeAttribute("src");
  $("#qrHint").hidden = Boolean(qr);
}

async function refreshStatus() {
  if (!state.sessionId) return;
  try {
    const data = await apiRequest(`/api/session/${encodeURIComponent(state.sessionId)}`);
    showStatus(data.status);
    if (data.qr) showQr(data.qr);
    if (data.code) $("#pairingCode").textContent = data.code;
    if (data.message) setMessage(data.message, ["error", "closed", "logged_out"].includes(data.status) ? "error" : "success");
    if (["connected", "closed", "error", "logged_out"].includes(data.status)) stopPolling();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function createSession(mode) {
  stopPolling();
  state.sessionId = null;
  $("#sessionId").textContent = "Creating…";
  $("#pairingCode").textContent = "—";
  showQr(null);
  showStatus("starting");
  setMessage("Starting a new WhatsApp session…");

  try {
    const payload = mode === "pairing"
      ? { phone: $("#phoneNumber").value.trim() }
      : {};
    const data = await apiRequest(
      mode === "pairing" ? "/api/session/pairing" : "/api/session/qr",
      { method: "POST", body: JSON.stringify(payload) }
    );

    state.sessionId = data.id;
    $("#sessionId").textContent = data.id;
    if (data.code) $("#pairingCode").textContent = data.code;
    if (data.qr) showQr(data.qr);
    showStatus(data.status);
    setMessage(data.message || "Session started.", "success");
    await refreshStatus();
    state.pollTimer = setInterval(refreshStatus, 2000);
  } catch (error) {
    $("#sessionId").textContent = "Not created";
    showStatus("error");
    setMessage(error.message, "error");
  }
}

async function copyCode() {
  const value = $("#pairingCode").textContent.trim();
  if (!value || value === "—") return setMessage("No pairing code to copy yet.", "error");
  try {
    await navigator.clipboard.writeText(value);
    setMessage("Pairing code copied.", "success");
  } catch {
    setMessage("Clipboard unavailable. Copy the code manually.", "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("#pairingButton").addEventListener("click", () => createSession("pairing"));
  $("#qrButton").addEventListener("click", () => createSession("qr"));
  $("#copyCodeButton").addEventListener("click", copyCode);
  $("#refreshButton").addEventListener("click", refreshStatus);
  $("#stopButton").addEventListener("click", () => {
    stopPolling();
    setMessage("Automatic refresh paused. This does not disconnect WhatsApp.");
  });
});
