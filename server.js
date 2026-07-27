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

const ROOMS_DIR = path.join(DATA_DIR, "rooms");
const SHOWS_FILE = path.join(DATA_DIR, "shows.json");
// Pre-rooms builds kept a single global timer here. Migrated into room "main".
const LEGACY_STATE_FILE = path.join(DATA_DIR, "state.json");

// Optional. When unset the control API is open, which is how this ran before.
const CONTROL_PASSCODE = process.env.CONTROL_PASSCODE || "";

// If the server was only down briefly, a running timer should pick up where the
// real world got to. Longer than this and we refuse to guess, and restore paused.
const RESUME_GRACE_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 10000;
const CORRECTION_TICK_MS = 1000;

// The bare domain and /dashboard drive this room, so its URL is public and
// guessable — it keeps the global passcode. Freshly created rooms are guarded
// by their unguessable id instead (the link is the key).
const DEFAULT_ROOM_ID = "main";

// Rooms nobody has touched in this long are pruned at boot so abandoned links
// don't accumulate forever. The default room is never pruned.
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Deliberately excludes 0/1/o/l/i so a room id read off a screen is unambiguous.
const ROOM_ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const ROOM_ID_RE = /^[a-z0-9]{4,32}$/;

/* ── Timer state ─────────────────────────────────────────────────────────── */

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

// The subset a Show template carries: the agenda and its display settings, but
// none of the live clock (running, remaining, alerts).
const SHOW_KEYS = [
  "sessionLabel", "countupSessionLabel", "queuedSpeakers",
  "warningThresholdSeconds", "dangerThresholdSeconds", "timeZone", "clockFormat"
];

/**
 * A room is one independent timer. Everything that used to be a single global
 * is now held per-room: the state, the monotonic anchor elapsed time is
 * measured against, and the set of connected SSE clients.
 */
const rooms = new Map(); // id -> { id, name, state, anchorMono, clients:Set }
let shows = [];          // [{ id, name, createdAt, payload }]

/* ── ICU / validation ────────────────────────────────────────────────────── */

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

function newRoomId() {
  let id;
  do {
    const bytes = crypto.randomBytes(7);
    id = "";
    for (let i = 0; i < bytes.length; i++) {
      id += ROOM_ID_ALPHABET[bytes[i] % ROOM_ID_ALPHABET.length];
    }
  } while (rooms.has(id));
  return id;
}

function newShowId() {
  return `show-${crypto.randomBytes(5).toString("hex")}`;
}

function cleanName(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().slice(0, 80);
  return trimmed || fallback;
}

/* ── Rooms ───────────────────────────────────────────────────────────────── */

function makeRoom(id, name, state) {
  return {
    id,
    name: name || (id === DEFAULT_ROOM_ID ? "Main Timer" : "Untitled Room"),
    state: state || defaultState(),
    anchorMono: performance.now(),
    clients: new Set()
  };
}

function ensureRoom(id, name) {
  let room = rooms.get(id);
  if (!room) {
    room = makeRoom(id, name);
    rooms.set(id, room);
    schedulePersist(id);
  }
  return room;
}

/**
 * Advances a room's timer to "now" against the monotonic clock and returns its
 * wire snapshot. Every duration on the wire is as-of-right-now, so clients
 * anchor it to their own clock and never have to agree with ours.
 */
function syncRoom(room) {
  const mono = performance.now();
  const s = room.state;

  if (s.alertExpiresAt && Date.now() >= s.alertExpiresAt) {
    room.state = { ...s, activeAlert: null, alertExpiresAt: null };
  }

  if (!room.state.running) {
    room.anchorMono = mono;
    return wireSnapshot(room);
  }

  const elapsed = Math.max(0, mono - room.anchorMono);
  room.anchorMono = mono;
  if (elapsed === 0) return wireSnapshot(room);

  if (room.state.timerMode === "countup") {
    room.state = { ...room.state, countupMs: room.state.countupMs + elapsed, updatedAt: Date.now() };
    return wireSnapshot(room);
  }

  const remainingMs = Math.max(0, room.state.remainingMs - elapsed);
  const finished = remainingMs === 0;
  room.state = {
    ...room.state,
    remainingMs,
    running: !finished,
    finishedAt: finished ? Date.now() : room.state.finishedAt,
    updatedAt: Date.now()
  };
  return wireSnapshot(room);
}

function wireSnapshot(room) {
  return {
    ...room.state,
    roomId: room.id,
    roomName: room.name,
    isDefaultRoom: room.id === DEFAULT_ROOM_ID,
    alertRemainingMs: room.state.alertExpiresAt
      ? Math.max(0, room.state.alertExpiresAt - Date.now())
      : null,
    serverTime: Date.now()
  };
}

function commitRoom(room, nextState) {
  room.state = {
    ...nextState,
    queuedSpeakers: normalizeQueuedSpeakers(nextState.queuedSpeakers),
    updatedAt: Date.now()
  };
  room.anchorMono = performance.now();
  broadcastRoom(room);
  schedulePersist(room.id);
}

function broadcastRoom(room) {
  if (room.clients.size === 0) return;
  const payload = `data: ${JSON.stringify(syncRoom(room))}\n\n`;
  for (const client of room.clients) {
    writeToClient(room, client, payload);
  }
}

// A dead socket must never take the process down mid-event.
function writeToClient(room, client, payload) {
  try {
    if (client.writableEnded || client.destroyed) {
      room.clients.delete(client);
      return;
    }
    client.write(payload);
  } catch (err) {
    room.clients.delete(client);
    try {
      client.end();
    } catch (_) {
      /* already gone */
    }
  }
}

function totalClients() {
  let n = 0;
  for (const room of rooms.values()) n += room.clients.size;
  return n;
}

/* ── Shows (agenda templates) ────────────────────────────────────────────── */

function showSummary(show) {
  const queue = Array.isArray(show.payload.queuedSpeakers) ? show.payload.queuedSpeakers : [];
  return {
    id: show.id,
    name: show.name,
    createdAt: show.createdAt,
    sessionCount: queue.length,
    totalSeconds: queue.reduce((sum, q) => sum + (Number.isFinite(q.totalSeconds) ? q.totalSeconds : 0), 0)
  };
}

function captureShow(room, name) {
  const snapshot = syncRoom(room);
  const payload = {};
  for (const key of SHOW_KEYS) payload[key] = snapshot[key];
  payload.queuedSpeakers = normalizeQueuedSpeakers(payload.queuedSpeakers);
  return { id: newShowId(), name: cleanName(name, "Untitled Show"), createdAt: Date.now(), payload };
}

// Loading a show populates the agenda and display settings but stops the clock
// and returns to wall-clock mode, so it can never silently nuke a live countdown.
function applyShowToState(state, show) {
  const next = { ...state };
  const p = show.payload || {};
  for (const key of SHOW_KEYS) {
    if (p[key] !== undefined) next[key] = p[key];
  }
  // Fresh ids so a show loaded twice can't collide with an existing queue item.
  next.queuedSpeakers = normalizeQueuedSpeakers(p.queuedSpeakers).map((q) => ({ ...q, id: createId() }));
  next.running = false;
  next.finishedAt = null;
  next.clockMode = true;
  next.activeAlert = null;
  next.alertExpiresAt = null;
  next.customMessage = "";
  next.messageVisible = false;
  return next;
}

/* ── Persistence ─────────────────────────────────────────────────────────── */

function roomFile(id) {
  return path.join(ROOMS_DIR, `${id}.json`);
}

const dirtyRooms = new Set();
let persistTimer = null;
let persistInFlight = false;

function schedulePersist(roomId) {
  if (roomId) dirtyRooms.add(roomId);
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushDirty();
  }, 300);
}

async function flushDirty() {
  if (persistInFlight) {
    schedulePersist();
    return;
  }
  persistInFlight = true;
  const ids = [...dirtyRooms];
  dirtyRooms.clear();
  try {
    await fsp.mkdir(ROOMS_DIR, { recursive: true });
    for (const id of ids) {
      const room = rooms.get(id);
      if (!room) {
        // Room was deleted — remove its file.
        await fsp.rm(roomFile(id), { force: true });
        continue;
      }
      await writeRoomFile(room);
    }
  } catch (err) {
    console.error("[persist] could not save rooms:", err.message);
    for (const id of ids) dirtyRooms.add(id); // retry next tick
  } finally {
    persistInFlight = false;
    if (dirtyRooms.size > 0) schedulePersist();
  }
}

async function writeRoomFile(room) {
  const snapshot = syncRoom(room);
  const data = { savedAt: Date.now(), name: room.name };
  for (const key of PERSIST_KEYS) data[key] = snapshot[key];
  const file = roomFile(room.id);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

let showsDirty = false;
let showsTimer = null;

function scheduleShowsPersist() {
  showsDirty = true;
  if (showsTimer) return;
  showsTimer = setTimeout(async () => {
    showsTimer = null;
    if (!showsDirty) return;
    showsDirty = false;
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${SHOWS_FILE}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(shows));
      await fsp.rename(tmp, SHOWS_FILE);
    } catch (err) {
      console.error("[persist] could not save shows:", err.message);
      showsDirty = true;
    }
  }, 300);
}

// Rebuilds a room's live state from a saved file, advancing a running timer by
// the downtime (up to the grace window) so it stays honest across a restart.
function reviveState(saved) {
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
    } else {
      restored.running = false;
    }
  }
  return restored;
}

function loadAll() {
  // 1. Migrate a pre-rooms single-state file into the default room.
  try {
    const saved = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, "utf8"));
    fs.mkdirSync(ROOMS_DIR, { recursive: true });
    if (!fs.existsSync(roomFile(DEFAULT_ROOM_ID))) {
      const migrated = { savedAt: saved.savedAt || Date.now(), name: "Main Timer" };
      for (const key of PERSIST_KEYS) if (saved[key] !== undefined) migrated[key] = saved[key];
      fs.writeFileSync(roomFile(DEFAULT_ROOM_ID), JSON.stringify(migrated));
      console.log("[migrate] folded legacy state.json into room 'main'");
    }
    // Keep the original as a backup rather than deleting it.
    fs.renameSync(LEGACY_STATE_FILE, `${LEGACY_STATE_FILE}.migrated`);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[migrate] skipped:", err.message);
  }

  // 2. Load every room file.
  let files = [];
  try {
    files = fs.readdirSync(ROOMS_DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[restore] cannot read rooms dir:", err.message);
  }

  for (const file of files) {
    const id = path.basename(file, ".json");
    if (!ROOM_ID_RE.test(id) && id !== DEFAULT_ROOM_ID) continue;
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, file), "utf8"));
      const room = makeRoom(id, saved.name, reviveState(saved));
      rooms.set(id, room);
    } catch (err) {
      console.error(`[restore] ignoring unreadable room ${id}:`, err.message);
    }
  }

  // 3. Prune stale rooms (never the default).
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (id === DEFAULT_ROOM_ID) continue;
    const age = now - (room.state.updatedAt || 0);
    if (age > ROOM_TTL_MS) {
      rooms.delete(id);
      fs.rmSync(roomFile(id), { force: true });
      console.log(`[prune] removed room ${id} (idle ${Math.round(age / 86400000)}d)`);
    }
  }

  // 4. Guarantee the default room exists.
  if (!rooms.has(DEFAULT_ROOM_ID)) {
    rooms.set(DEFAULT_ROOM_ID, makeRoom(DEFAULT_ROOM_ID, "Main Timer"));
  }

  // 5. Load shows.
  try {
    const parsed = JSON.parse(fs.readFileSync(SHOWS_FILE, "utf8"));
    if (Array.isArray(parsed)) {
      shows = parsed.filter((s) => s && typeof s.id === "string" && s.payload).map((s) => ({
        id: s.id,
        name: cleanName(s.name, "Untitled Show"),
        createdAt: Number.isFinite(s.createdAt) ? s.createdAt : Date.now(),
        payload: s.payload
      }));
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[restore] ignoring unreadable shows:", err.message);
  }

  console.log(`[restore] ${rooms.size} room(s), ${shows.length} show(s)`);
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

function applyPatch(room, body) {
  const state = syncRoom(room);
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
  if (typeof body.roomName === "string") {
    room.name = cleanName(body.roomName, room.name);
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
  if (body.action === "loadShow") {
    const show = shows.find((s) => s.id === body.showId);
    if (!show) throw new Error("Show not found");
    return applyShowToState(next, show);
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

function openEventStream(req, res, room) {
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
  res.write(`data: ${JSON.stringify(syncRoom(room))}\n\n`);
  room.clients.add(res);

  const drop = () => room.clients.delete(res);
  req.on("close", drop);
  req.on("error", drop);
  res.on("error", drop);
}

async function handleRoomState(req, res, room, isHead) {
  if (req.method === "GET" || isHead) {
    sendJson(res, 200, syncRoom(room), isHead);
    return;
  }
  // POST — control. The default room keeps the passcode (its URL is public);
  // other rooms are gated only by their unguessable id.
  if (room.id === DEFAULT_ROOM_ID && !isAuthorised(req)) {
    sendJson(res, 401, { error: "Passcode required" });
    return;
  }
  try {
    const body = await readBody(req);
    commitRoom(room, applyPatch(room, body));
    sendJson(res, 200, syncRoom(room));
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
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
  const pathname = url.pathname;

  /* — health & config — */
  if (isRead && pathname === "/healthz") {
    sendJson(res, 200, { ok: true, rooms: rooms.size, clients: totalClients(), shows: shows.length, uptime: Math.round(process.uptime()) }, isHead);
    return;
  }
  if (isRead && pathname === "/api/config") {
    sendJson(res, 200, { passcodeRequired: Boolean(CONTROL_PASSCODE) }, isHead);
    return;
  }

  /* — rooms admin — */
  if (pathname === "/api/rooms") {
    if (!isAuthorised(req)) {
      sendJson(res, 401, { error: "Passcode required" });
      return;
    }
    if (req.method === "GET" || isHead) {
      const list = [...rooms.values()].map((room) => {
        const s = syncRoom(room);
        return { id: room.id, name: room.name, isDefaultRoom: room.id === DEFAULT_ROOM_ID, running: s.running, updatedAt: s.updatedAt, sessionCount: s.queuedSpeakers.length };
      }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      sendJson(res, 200, { rooms: list }, isHead);
      return;
    }
    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        const id = newRoomId();
        const room = makeRoom(id, cleanName(body.name, "Untitled Room"));
        if (body.showId) {
          const show = shows.find((s) => s.id === body.showId);
          if (!show) throw new Error("Show not found");
          room.state = applyShowToState(room.state, show);
          if (!body.name) room.name = show.name;
        }
        rooms.set(id, room);
        schedulePersist(id);
        sendJson(res, 201, { id, name: room.name });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }
    sendText(res, 405, "Method not allowed");
    return;
  }

  const roomDelete = pathname.match(/^\/api\/rooms\/([a-z0-9]+)$/i);
  if (roomDelete && req.method === "DELETE") {
    if (!isAuthorised(req)) {
      sendJson(res, 401, { error: "Passcode required" });
      return;
    }
    const id = roomDelete[1];
    if (id === DEFAULT_ROOM_ID) {
      sendJson(res, 400, { error: "The default room cannot be deleted" });
      return;
    }
    const room = rooms.get(id);
    if (!room) {
      sendJson(res, 404, { error: "Room not found" });
      return;
    }
    for (const client of room.clients) {
      try { client.end(); } catch (_) { /* gone */ }
    }
    rooms.delete(id);
    schedulePersist(id); // flush notices the room is gone and removes the file
    sendJson(res, 200, { ok: true });
    return;
  }

  /* — shows — */
  if (pathname === "/api/shows") {
    if (req.method === "GET" || isHead) {
      sendJson(res, 200, { shows: shows.map(showSummary) }, isHead);
      return;
    }
    if (req.method === "POST") {
      if (!isAuthorised(req)) {
        sendJson(res, 401, { error: "Passcode required" });
        return;
      }
      try {
        const body = await readBody(req);
        const room = rooms.get(body.roomId || DEFAULT_ROOM_ID);
        if (!room) throw new Error("Room not found");
        const show = captureShow(room, body.name);
        shows.push(show);
        scheduleShowsPersist();
        sendJson(res, 201, showSummary(show));
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }
    sendText(res, 405, "Method not allowed");
    return;
  }

  const showDelete = pathname.match(/^\/api\/shows\/(show-[a-z0-9]+)$/i);
  if (showDelete && req.method === "DELETE") {
    if (!isAuthorised(req)) {
      sendJson(res, 401, { error: "Passcode required" });
      return;
    }
    const before = shows.length;
    shows = shows.filter((s) => s.id !== showDelete[1]);
    if (shows.length === before) {
      sendJson(res, 404, { error: "Show not found" });
      return;
    }
    scheduleShowsPersist();
    sendJson(res, 200, { ok: true });
    return;
  }

  /* — per-room routes: /r/<id>/... — */
  const roomRoute = pathname.match(/^\/r\/([^/]+)(\/.*)?$/);
  if (roomRoute) {
    const id = roomRoute[1].toLowerCase();
    const rest = roomRoute[2] || "/";

    if (!ROOM_ID_RE.test(id)) {
      sendText(res, 404, "Room not found");
      return;
    }

    // HTML shells are served even for unknown rooms; the client shows a
    // "room not found" state when its first API call 404s.
    if (isRead && (rest === "/" || rest === "/dashboard")) {
      serveFile(res, path.join(PUBLIC_DIR, "dashboard.html"), isHead);
      return;
    }
    if (isRead && rest === "/stage") {
      serveFile(res, path.join(PUBLIC_DIR, "stage.html"), isHead);
      return;
    }

    const room = rooms.get(id);
    if (!room) {
      sendJson(res, 404, { error: "Room not found" });
      return;
    }
    if (req.method === "GET" && rest === "/events") {
      openEventStream(req, res, room);
      return;
    }
    if (rest === "/api/state") {
      await handleRoomState(req, res, room, isHead);
      return;
    }
    sendText(res, 404, "Not found");
    return;
  }

  /* — legacy default-room routes — */
  if (req.method === "GET" && pathname === "/events") {
    openEventStream(req, res, rooms.get(DEFAULT_ROOM_ID));
    return;
  }
  if (pathname === "/api/state" && (isRead || req.method === "POST")) {
    await handleRoomState(req, res, rooms.get(DEFAULT_ROOM_ID), isHead);
    return;
  }

  if (!isRead) {
    sendText(res, 405, "Method not allowed");
    return;
  }

  /* — pages — */
  if (pathname === "/") {
    serveFile(res, path.join(PUBLIC_DIR, "lobby.html"), isHead);
    return;
  }
  if (pathname === "/dashboard") {
    serveFile(res, path.join(PUBLIC_DIR, "dashboard.html"), isHead);
    return;
  }
  if (pathname === "/stage") {
    serveFile(res, path.join(PUBLIC_DIR, "stage.html"), isHead);
    return;
  }

  /* — static assets — */
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
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

loadAll();

server.listen(PORT, HOST, () => {
  console.log(`Stage Timer App running at http://${HOST}:${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(CONTROL_PASSCODE ? "Control API: passcode protected (creation + default room)" : "Control API: open (set CONTROL_PASSCODE to lock)");
});

// Clients tick locally between these, so this is only a drift correction.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.clients.size > 0 && (room.state.running || room.state.activeAlert)) {
      broadcastRoom(room);
    }
  }
}, CORRECTION_TICK_MS);

// Named event rather than a bare comment so the browser can see it arrive and
// tell a live-but-quiet connection apart from a dead one.
setInterval(() => {
  const payload = `event: ping\ndata: ${Date.now()}\n\n`;
  for (const room of rooms.values()) {
    for (const client of room.clients) writeToClient(room, client, payload);
  }
}, HEARTBEAT_MS);

// Keep the on-disk copy fresh while any room is running.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state.running) schedulePersist(room.id);
  }
}, 5000);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`[${signal}] saving state before exit`);
    for (const id of rooms.keys()) dirtyRooms.add(id);
    Promise.all([flushDirty(), (async () => {
      if (showsDirty) {
        try {
          await fsp.mkdir(DATA_DIR, { recursive: true });
          await fsp.writeFile(SHOWS_FILE, JSON.stringify(shows));
        } catch (_) { /* best effort */ }
      }
    })()]).finally(() => process.exit(0));
  });
}
