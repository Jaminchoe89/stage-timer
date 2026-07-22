const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { performance } = require("perf_hooks");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, ".data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

// Optional. When unset the control API is open, which is how this ran before.
const CONTROL_PASSCODE = process.env.CONTROL_PASSCODE || "";

// If the server was only down briefly, a running timer should pick up where the
// real world got to. Longer than this and we refuse to guess, and restore paused.
const RESUME_GRACE_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 10000;
const CORRECTION_TICK_MS = 1000;

const clients = new Set();

const defaultState = () => ({
  speakerName: "Next Speaker",
  sessionLabel: "Main Stage",
  countupSessionLabel: "Count Up",
  customMessage: "",
  messageVisible: false,
  queuedSpeakers: [],
  blinkEnabled: true,
  showSessionLabel: false,
  timerVisible: true,
  clockMode: true,
  activeAlert: null,
  alertExpiresAt: null,
  timerMode: "countdown",
  totalSeconds: 900,
  remainingMs: 900000,
  countupMs: 0,
  running: false,
  warningThresholdSeconds: 120,
  dangerThresholdSeconds: 30,
  finishedAt: null,
  timeZone: null,
  clockFormat: "24h",
  updatedAt: Date.now()
});

// Everything worth surviving a restart. Alerts are deliberately excluded — a
// 7-second nudge should never reappear when the process comes back.
const PERSIST_KEYS = [
  "speakerName", "sessionLabel", "countupSessionLabel", "customMessage", "messageVisible",
  "queuedSpeakers", "blinkEnabled", "showSessionLabel", "timerVisible", "clockMode",
  "timerMode", "totalSeconds", "remainingMs", "countupMs", "running",
  "warningThresholdSeconds", "dangerThresholdSeconds", "timeZone", "clockFormat"
];

let timerState = defaultState();

// Elapsed time is measured against a monotonic clock, never Date.now(), so an
// NTP correction or a timezone change cannot make a running timer jump or stall.
let anchorMono = performance.now();

// A Node build without full ICU rejects perfectly valid zone names, so probe
// once at startup: ICU is only trusted if it accepts a real zone AND rejects a
// fake one. Otherwise an unconditional catch would wave everything through.
const ICU_TIMEZONES_USABLE = (() => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: "Asia/Bangkok" });
  } catch (_) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: "Mars/Olympus" });
    return false;
  } catch (_) {
    return true;
  }
})();

function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  if (ICU_TIMEZONES_USABLE) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch (_) {
      return false;
    }
  }
  return /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz);
}

function normalizeQueuedSpeakers(queue) {
  if (!Array.isArray(queue)) return [];
  return queue
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : createId(),
      sessionLabel: item.sessionLabel || item.speakerName || "",
      totalSeconds: Number.isFinite(item.totalSeconds) ? item.totalSeconds : 900,
      warningThresholdSeconds: Number.isFinite(item.warningThresholdSeconds) ? item.warningThresholdSeconds : 120
    }));
}

function createId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Advances the timer to "now" against the monotonic clock and returns the wire
 * snapshot. Every duration on the wire is expressed as-of-right-now, so clients
 * anchor it to their own clock and never have to agree with ours.
 */
function syncRunningState() {
  const mono = performance.now();

  if (timerState.alertExpiresAt && Date.now() >= timerState.alertExpiresAt) {
    timerState = { ...timerState, activeAlert: null, alertExpiresAt: null };
  }

  if (!timerState.running) {
    anchorMono = mono;
    return wireSnapshot();
  }

  const elapsed = Math.max(0, mono - anchorMono);
  anchorMono = mono;
  if (elapsed === 0) return wireSnapshot();

  if (timerState.timerMode === "countup") {
    timerState = { ...timerState, countupMs: timerState.countupMs + elapsed, updatedAt: Date.now() };
    return wireSnapshot();
  }

  const remainingMs = Math.max(0, timerState.remainingMs - elapsed);
  const finished = remainingMs === 0;
  timerState = {
    ...timerState,
    remainingMs,
    running: !finished,
    finishedAt: finished ? Date.now() : timerState.finishedAt,
    updatedAt: Date.now()
  };
  return wireSnapshot();
}

function wireSnapshot() {
  return {
    ...timerState,
    alertRemainingMs: timerState.alertExpiresAt
      ? Math.max(0, timerState.alertExpiresAt - Date.now())
      : null,
    serverTime: Date.now()
  };
}

function commitState(nextState) {
  timerState = {
    ...nextState,
    queuedSpeakers: normalizeQueuedSpeakers(nextState.queuedSpeakers),
    updatedAt: Date.now()
  };
  anchorMono = performance.now();
  broadcastState();
  schedulePersist();
}

function broadcastState() {
  const payload = `data: ${JSON.stringify(syncRunningState())}\n\n`;
  for (const client of clients) {
    writeToClient(client, payload);
  }
}

// A dead socket must never take the process down mid-event.
function writeToClient(client, payload) {
  try {
    if (client.writableEnded || client.destroyed) {
      clients.delete(client);
      return;
    }
    client.write(payload);
  } catch (err) {
    clients.delete(client);
    try {
      client.end();
    } catch (_) {
      /* already gone */
    }
  }
}

/* ── Persistence ─────────────────────────────────────────────────────────── */

let persistTimer = null;
let persistInFlight = false;
let persistPending = false;

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, 300);
}

async function persistNow() {
  if (persistInFlight) {
    persistPending = true;
    return;
  }
  persistInFlight = true;
  try {
    const snapshot = syncRunningState();
    const data = { savedAt: Date.now() };
    for (const key of PERSIST_KEYS) data[key] = snapshot[key];

    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, STATE_FILE);
  } catch (err) {
    console.error("[persist] could not save state:", err.message);
  } finally {
    persistInFlight = false;
    if (persistPending) {
      persistPending = false;
      schedulePersist();
    }
  }
}

function restoreState() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[restore] ignoring unreadable state file:", err.message);
    }
    return;
  }

  const restored = { ...defaultState() };
  for (const key of PERSIST_KEYS) {
    if (saved[key] !== undefined) restored[key] = saved[key];
  }
  restored.queuedSpeakers = normalizeQueuedSpeakers(restored.queuedSpeakers);
  restored.activeAlert = null;
  restored.alertExpiresAt = null;
  restored.updatedAt = Date.now();

  const gap = Number.isFinite(saved.savedAt) ? Date.now() - saved.savedAt : Infinity;

  if (restored.running && gap > 0) {
    if (gap <= RESUME_GRACE_MS) {
      if (restored.timerMode === "countup") {
        restored.countupMs += gap;
      } else {
        restored.remainingMs = Math.max(0, restored.remainingMs - gap);
        if (restored.remainingMs === 0) {
          restored.running = false;
          restored.finishedAt = Date.now();
        }
      }
      console.log(`[restore] resumed a running timer across a ${Math.round(gap / 1000)}s gap`);
    } else {
      restored.running = false;
      console.log(`[restore] gap of ${Math.round(gap / 1000)}s was too long — restored paused`);
    }
  }

  timerState = restored;
  anchorMono = performance.now();
}

/* ── HTTP helpers ────────────────────────────────────────────────────────── */

function sendJson(res, statusCode, data, isHead) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(isHead ? undefined : body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function isAuthorised(req) {
  if (!CONTROL_PASSCODE) return true;
  const supplied = req.headers["x-control-passcode"];
  if (typeof supplied !== "string") return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(CONTROL_PASSCODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ── State mutations ─────────────────────────────────────────────────────── */

function applyPatch(body) {
  const state = syncRunningState();
  const next = { ...state };
  next.queuedSpeakers = normalizeQueuedSpeakers(state.queuedSpeakers);

  if (typeof body.speakerName === "string") {
    next.speakerName = body.speakerName.trim() || "Next Speaker";
  }
  if (typeof body.sessionLabel === "string") {
    next.sessionLabel = body.sessionLabel.trim() || "Main Stage";
  }
  if (typeof body.countupSessionLabel === "string") {
    next.countupSessionLabel = body.countupSessionLabel.trim() || "Count Up";
  }
  if (typeof body.customMessage === "string") {
    next.customMessage = body.customMessage.trim();
  }
  if (typeof body.messageVisible === "boolean") {
    next.messageVisible = body.messageVisible;
  }
  if (typeof body.blinkEnabled === "boolean") {
    next.blinkEnabled = body.blinkEnabled;
  }
  if (typeof body.showSessionLabel === "boolean") {
    next.showSessionLabel = body.showSessionLabel;
  }
  if (body.timeZone === null || body.timeZone === "") {
    next.timeZone = null;
  } else if (typeof body.timeZone === "string") {
    const tz = body.timeZone.trim();
    if (!isValidTimeZone(tz)) throw new Error(`Unknown time zone: ${tz}`);
    next.timeZone = tz;
  }
  if (body.clockFormat === "12h" || body.clockFormat === "24h") {
    next.clockFormat = body.clockFormat;
  }
  if (Number.isFinite(body.warningThresholdSeconds)) {
    next.warningThresholdSeconds = Math.max(0, Math.floor(body.warningThresholdSeconds));
  }
  if (Number.isFinite(body.dangerThresholdSeconds)) {
    next.dangerThresholdSeconds = Math.max(0, Math.floor(body.dangerThresholdSeconds));
  }
  if (Number.isFinite(body.totalSeconds)) {
    const totalSeconds = Math.max(1, Math.floor(body.totalSeconds));
    next.timerMode = "countdown";
    next.totalSeconds = totalSeconds;
    next.remainingMs = totalSeconds * 1000;
    next.running = false;
    next.finishedAt = null;
    next.timerVisible = true;
  }
  if (body.action === "start") {
    next.timerMode = "countdown";
    if (next.remainingMs === 0) {
      next.remainingMs = next.totalSeconds * 1000;
    }
    next.running = true;
    next.finishedAt = null;
    next.timerVisible = true;
    next.clockMode = false;
  }
  if (body.action === "pause") {
    next.running = false;
  }
  if (body.action === "reset") {
    next.timerMode = "countdown";
    next.remainingMs = next.totalSeconds * 1000;
    next.running = false;
    next.finishedAt = null;
    next.timerVisible = true;
    next.clockMode = false;
  }
  if (body.action === "stop") {
    next.timerMode = "countdown";
    next.remainingMs = 0;
    next.running = false;
    next.finishedAt = null;
    next.timerVisible = false;
    next.clockMode = false;
  }
  if (body.action === "showTime") {
    next.clockMode = !next.clockMode;
  }
  if (body.action === "setClockMode" && typeof body.clockMode === "boolean") {
    next.clockMode = body.clockMode;
  }
  // The +/- buttons nudge the time left on the clock. They deliberately do NOT
  // touch totalSeconds: that is the session's planned length, it is what the
  // Duration card reports, and it is what Reset must return to. Letting
  // "- 5 min" rewrite it used to collapse a 15-minute session to 1 second.
  const adjustRemaining = (deltaMs) => {
    next.timerMode = "countdown";
    next.remainingMs = Math.max(0, next.remainingMs + deltaMs);
    next.timerVisible = true;
    next.clockMode = false;
    if (next.remainingMs === 0) {
      next.running = false;
      next.finishedAt = Date.now();
    } else {
      next.finishedAt = null;
    }
  };

  if (body.action === "addMinute") adjustRemaining(60000);
  if (body.action === "subtractMinute") adjustRemaining(-60000);
  if (body.action === "addFiveMinutes") adjustRemaining(300000);
  if (body.action === "subtractFiveMinutes") adjustRemaining(-300000);
  if (body.action === "startCountup") {
    next.timerMode = "countup";
    next.sessionLabel = next.countupSessionLabel;
    next.running = true;
    next.finishedAt = null;
    next.timerVisible = true;
    next.clockMode = false;
  }
  if (body.action === "pauseCountup") {
    next.timerMode = "countup";
    next.running = false;
  }
  if (body.action === "resetCountup") {
    next.timerMode = "countup";
    next.sessionLabel = next.countupSessionLabel;
    next.countupMs = 0;
    next.running = false;
    next.finishedAt = null;
  }
  if (body.action === "addQueuedSpeaker") {
    const sessionLabel = typeof body.queueSpeakerName === "string" ? body.queueSpeakerName.trim() : "";
    const totalSeconds = Number.isFinite(body.queueSpeakerSeconds) ? Math.max(1, Math.floor(body.queueSpeakerSeconds)) : 0;
    const warningThresholdSeconds = Number.isFinite(body.queueWarningThresholdSeconds)
      ? Math.max(0, Math.floor(body.queueWarningThresholdSeconds))
      : 120;
    if (!totalSeconds) {
      throw new Error("Duration is required");
    }
    next.queuedSpeakers.push({ id: createId(), sessionLabel, totalSeconds, warningThresholdSeconds });
  }
  if (body.action === "loadNow") {
    const sessionLabel = typeof body.queueSpeakerName === "string" ? body.queueSpeakerName.trim() : "";
    const totalSeconds = Number.isFinite(body.queueSpeakerSeconds) ? Math.max(1, Math.floor(body.queueSpeakerSeconds)) : 0;
    const warningThresholdSeconds = Number.isFinite(body.queueWarningThresholdSeconds)
      ? Math.max(0, Math.floor(body.queueWarningThresholdSeconds))
      : 120;
    if (!totalSeconds) throw new Error("Duration is required");
    next.sessionLabel = sessionLabel;
    next.timerMode = "countdown";
    next.totalSeconds = totalSeconds;
    next.remainingMs = totalSeconds * 1000;
    next.warningThresholdSeconds = warningThresholdSeconds;
    next.running = false;
    next.finishedAt = null;
    next.timerVisible = true;
    next.clockMode = false;
  }
  if (body.action === "removeQueuedSpeaker") {
    next.queuedSpeakers = next.queuedSpeakers.filter((speaker) => speaker.id !== body.queueSpeakerId);
  }
  if (body.action === "clearQueue") {
    next.queuedSpeakers = [];
  }
  if (body.action === "moveQueuedSpeaker") {
    const index = next.queuedSpeakers.findIndex((speaker) => speaker.id === body.queueSpeakerId);
    const direction = body.direction === "up" ? -1 : body.direction === "down" ? 1 : 0;
    const targetIndex = index + direction;
    if (index !== -1 && targetIndex >= 0 && targetIndex < next.queuedSpeakers.length) {
      const [speaker] = next.queuedSpeakers.splice(index, 1);
      next.queuedSpeakers.splice(targetIndex, 0, speaker);
    }
  }
  if (body.action === "loadQueuedSpeaker") {
    const queuedSpeaker = next.queuedSpeakers.find((speaker) => speaker.id === body.queueSpeakerId);
    if (!queuedSpeaker) {
      throw new Error("Queued speaker not found");
    }
    next.sessionLabel = queuedSpeaker.sessionLabel;
    next.timerMode = "countdown";
    next.totalSeconds = queuedSpeaker.totalSeconds;
    next.remainingMs = queuedSpeaker.totalSeconds * 1000;
    next.warningThresholdSeconds = queuedSpeaker.warningThresholdSeconds;
    next.running = false;
    next.finishedAt = null;
    next.timerVisible = true;
    next.clockMode = false;
    if (body.removeAfterLoad) {
      next.queuedSpeakers = next.queuedSpeakers.filter((speaker) => speaker.id !== body.queueSpeakerId);
    }
  }
  if (body.action === "sendMessage") {
    next.customMessage = typeof body.messageText === "string" ? body.messageText.trim() : "";
    next.messageVisible = next.customMessage.length > 0;
  }
  if (body.action === "showMicAlert") {
    next.activeAlert = "mic";
    next.alertExpiresAt = Date.now() + 7000;
  }
  if (body.action === "showVoiceAlert") {
    next.activeAlert = "voice";
    next.alertExpiresAt = Date.now() + 7000;
  }
  if (body.action === "showWrapupAlert") {
    next.activeAlert = "wrapup";
    next.alertExpiresAt = Date.now() + 7000;
  }
  if (body.action === "clearAlert") {
    next.activeAlert = null;
    next.alertExpiresAt = null;
  }
  if (body.action === "clearMessage") {
    next.customMessage = "";
    next.messageVisible = false;
  }
  if (body.action === "hideMessage") {
    next.messageVisible = false;
  }
  if (body.action === "unhideMessage") {
    next.messageVisible = next.customMessage.length > 0;
  }

  return next;
}

/* ── Static files ────────────────────────────────────────────────────────── */

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8"
};

// Markup and code stay uncached so a redeploy is picked up instantly mid-event;
// fonts and images are content-stable and can be cached hard.
const LONG_CACHE = new Set([".png", ".jpg", ".jpeg", ".svg", ".ico", ".woff2", ".woff"]);

function serveFile(res, filePath, isHead) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": LONG_CACHE.has(ext) ? "public, max-age=604800" : "no-store"
    });
    res.end(isHead ? undefined : data);
  });
}

/* ── Server ──────────────────────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("[request] unhandled failure:", err);
    if (!res.headersSent) sendText(res, 500, "Internal error");
    else res.end();
  });
});

async function handleRequest(req, res) {
  const isHead = req.method === "HEAD";
  const isRead = req.method === "GET" || isHead;

  // Parsed against a fixed base — the Host header is attacker-controlled and a
  // malformed one used to throw here and take the whole process down.
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch (_) {
    sendText(res, 400, "Bad request");
    return;
  }

  if (isRead && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true, clients: clients.size, uptime: Math.round(process.uptime()) }, isHead);
    return;
  }

  if (isRead && url.pathname === "/api/config") {
    sendJson(res, 200, { passcodeRequired: Boolean(CONTROL_PASSCODE) }, isHead);
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // Stops nginx-style reverse proxies (Railway included) from buffering the
      // stream, which otherwise makes the display look frozen.
      "X-Accel-Buffering": "no"
    });
    if (res.socket) {
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true, 30000);
      res.socket.setTimeout(0);
    }
    res.write("retry: 2000\n\n");
    res.write(`data: ${JSON.stringify(syncRunningState())}\n\n`);
    clients.add(res);

    const drop = () => clients.delete(res);
    req.on("close", drop);
    req.on("error", drop);
    res.on("error", drop);
    return;
  }

  if (isRead && url.pathname === "/api/state") {
    sendJson(res, 200, syncRunningState(), isHead);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/state") {
    if (!isAuthorised(req)) {
      sendJson(res, 401, { error: "Passcode required" });
      return;
    }
    try {
      const body = await readBody(req);
      commitState(applyPatch(body));
      sendJson(res, 200, syncRunningState());
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (!isRead) {
    sendText(res, 405, "Method not allowed");
    return;
  }

  if (url.pathname === "/" || url.pathname === "/dashboard") {
    serveFile(res, path.join(PUBLIC_DIR, "dashboard.html"), isHead);
    return;
  }

  if (url.pathname === "/stage") {
    serveFile(res, path.join(PUBLIC_DIR, "stage.html"), isHead);
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch (_) {
    sendText(res, 400, "Bad request");
    return;
  }

  const requestedPath = path.normalize(path.join(PUBLIC_DIR, decodedPath));
  if (requestedPath !== PUBLIC_DIR && !requestedPath.startsWith(PUBLIC_DIR + path.sep)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  serveFile(res, requestedPath, isHead);
}

// A garbled request line or header must not be fatal either.
server.on("clientError", (err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  else socket.destroy();
});

// Last line of defence. An event display going dark is far worse than a process
// limping along with a logged error.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] kept the server alive:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection] kept the server alive:", err);
});

restoreState();

server.listen(PORT, HOST, () => {
  console.log(`Stage Timer App running at http://${HOST}:${PORT}`);
  console.log(`State file: ${STATE_FILE}`);
  console.log(CONTROL_PASSCODE ? "Control API: passcode protected" : "Control API: open (set CONTROL_PASSCODE to lock)");
});

// Clients tick locally between these, so this is only a drift correction.
setInterval(() => {
  if (clients.size > 0 && (timerState.running || timerState.activeAlert)) {
    broadcastState();
  }
}, CORRECTION_TICK_MS);

// Named event rather than a bare comment so the browser can see it arrive and
// tell a live-but-quiet connection apart from a dead one.
setInterval(() => {
  const payload = `event: ping\ndata: ${Date.now()}\n\n`;
  for (const client of clients) writeToClient(client, payload);
}, HEARTBEAT_MS);

// Keep the on-disk copy fresh while a session is running.
setInterval(() => {
  if (timerState.running) schedulePersist();
}, 5000);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`[${signal}] saving state before exit`);
    persistNow().finally(() => process.exit(0));
  });
}
