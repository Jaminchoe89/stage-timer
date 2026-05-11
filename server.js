const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");

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
  updatedAt: Date.now()
});

let timerState = defaultState();

function normalizeQueuedSpeakers(queue = []) {
  return queue.map((item) => ({
    id: item.id,
    sessionLabel: item.sessionLabel || item.speakerName || "Untitled Session",
    totalSeconds: Number.isFinite(item.totalSeconds) ? item.totalSeconds : 900,
    warningThresholdSeconds: Number.isFinite(item.warningThresholdSeconds) ? item.warningThresholdSeconds : 120
  }));
}

function currentState() {
  if (!timerState.running) {
    timerState = {
      ...timerState,
      queuedSpeakers: normalizeQueuedSpeakers(timerState.queuedSpeakers)
    };
    return timerState;
  }

  const elapsed = Date.now() - timerState.updatedAt;
  if (timerState.timerMode === "countup") {
    return {
      ...timerState,
      countupMs: timerState.countupMs + elapsed,
      updatedAt: Date.now()
    };
  }

  const remainingMs = Math.max(0, timerState.remainingMs - elapsed);
  const finished = remainingMs === 0;

  return {
    ...timerState,
    remainingMs,
    running: !finished,
    finishedAt: finished ? Date.now() : timerState.finishedAt,
    updatedAt: Date.now()
  };
}

function syncRunningState() {
  if (timerState.alertExpiresAt && Date.now() >= timerState.alertExpiresAt) {
    timerState = { ...timerState, activeAlert: null, alertExpiresAt: null };
  }

  if (!timerState.running) {
    timerState = {
      ...timerState,
      queuedSpeakers: normalizeQueuedSpeakers(timerState.queuedSpeakers)
    };
    return timerState;
  }

  const now = Date.now();
  const elapsed = now - timerState.updatedAt;
  if (elapsed <= 0) {
    return timerState;
  }

  if (timerState.timerMode === "countup") {
    timerState = {
      ...timerState,
      countupMs: timerState.countupMs + elapsed,
      updatedAt: now
    };
    return timerState;
  }

  const remainingMs = Math.max(0, timerState.remainingMs - elapsed);
  const finished = remainingMs === 0;

  timerState = {
    ...timerState,
    remainingMs,
    running: !finished,
    finishedAt: finished ? now : timerState.finishedAt,
    updatedAt: now
  };
  return timerState;
}

function commitState(nextState) {
  timerState = {
    ...nextState,
    queuedSpeakers: normalizeQueuedSpeakers(nextState.queuedSpeakers),
    updatedAt: Date.now()
  };
  broadcastState();
}

function broadcastState() {
  const payload = `data: ${JSON.stringify(syncRunningState())}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
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

function applyPatch(body) {
  const state = currentState();
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
  if (body.action === "addMinute") {
    next.timerMode = "countdown";
    next.remainingMs += 60000;
    next.totalSeconds = Math.max(next.totalSeconds, Math.ceil(next.remainingMs / 1000));
    next.finishedAt = null;
    next.timerVisible = true;
    next.clockMode = false;
  }
  if (body.action === "subtractMinute") {
    next.timerMode = "countdown";
    next.remainingMs = Math.max(0, next.remainingMs - 60000);
    next.totalSeconds = Math.max(1, Math.ceil(next.remainingMs / 1000));
    if (next.remainingMs === 0) {
      next.running = false;
      next.finishedAt = Date.now();
    }
    next.timerVisible = true;
    next.clockMode = false;
  }
  if (body.action === "addFiveMinutes") {
    next.timerMode = "countdown";
    next.remainingMs += 300000;
    next.totalSeconds = Math.max(next.totalSeconds, Math.ceil(next.remainingMs / 1000));
    next.finishedAt = null;
    next.timerVisible = true;
    next.clockMode = false;
  }
  if (body.action === "subtractFiveMinutes") {
    next.timerMode = "countdown";
    next.remainingMs = Math.max(0, next.remainingMs - 300000);
    next.totalSeconds = Math.max(1, Math.ceil(next.remainingMs / 1000));
    if (next.remainingMs === 0) {
      next.running = false;
      next.finishedAt = Date.now();
    }
    next.timerVisible = true;
    next.clockMode = false;
  }
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
    next.queuedSpeakers.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionLabel,
      totalSeconds,
      warningThresholdSeconds
    });
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
    next.dangerThresholdSeconds = next.dangerThresholdSeconds || 0;
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

function contentTypeFor(filePath) {
  const ext = path.extname(filePath);
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    res.write(`data: ${JSON.stringify(syncRunningState())}\n\n`);
    clients.add(res);
    req.on("close", () => {
      clients.delete(res);
    });
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/state") {
    sendJson(res, 200, syncRunningState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/state") {
    try {
      const body = await readBody(req);
      const nextState = applyPatch(body);
      commitState(nextState);
      sendJson(res, 200, syncRunningState());
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
    serveFile(res, path.join(PUBLIC_DIR, "dashboard.html"));
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/dashboard") {
    serveFile(res, path.join(PUBLIC_DIR, "dashboard.html"));
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/stage") {
    serveFile(res, path.join(PUBLIC_DIR, "stage.html"));
    return;
  }

  if (!(req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }

  const requestedPath = path.normalize(path.join(PUBLIC_DIR, url.pathname));
  if (!requestedPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  serveFile(res, requestedPath);
});

server.listen(PORT, HOST, () => {
  console.log(`Stage Timer App running at http://${HOST}:${PORT}`);
});

setInterval(() => {
  if (clients.size > 0 && (timerState.running || timerState.activeAlert)) {
    broadcastState();
  }
}, 250);
