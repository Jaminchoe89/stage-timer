/* ── Formatting ──────────────────────────────────────────────────────────── */

// Intl formatters are expensive to build, and the render loop runs 10x a second.
let clockFormatterKey = null;
let clockFormatter = null;

function wallClockFormatter(state) {
  const timeZone = state && state.timeZone ? state.timeZone : null;
  const twelveHour = Boolean(state && state.clockFormat === "12h");
  const key = `${timeZone}|${twelveHour}`;

  if (key !== clockFormatterKey) {
    const locale = twelveHour ? "en-US" : "en-GB";
    const options = { hour: "2-digit", minute: "2-digit", hour12: twelveHour };
    if (timeZone) options.timeZone = timeZone;
    try {
      clockFormatter = new Intl.DateTimeFormat(locale, options);
    } catch (_) {
      // Unknown zone on this device — fall back to its own local time.
      delete options.timeZone;
      clockFormatter = new Intl.DateTimeFormat(locale, options);
    }
    clockFormatterKey = key;
  }

  return clockFormatter;
}

/**
 * The wall clock is rendered in the timezone held in shared state, not the
 * display device's OS timezone — venue screens are routinely set to the wrong
 * country and we cannot audit every one of them.
 */
function formatWallClock(state) {
  // Newer ICU emits a narrow no-break space before AM/PM; normalise it so the
  // stage font renders a predictable gap at display sizes.
  return wallClockFormatter(state).format(new Date()).replace(/\u202F/g, " ");
}

function detectedTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch (_) {
    return "";
  }
}

function formatClock(remainingMs) {
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) {
    return `${minutes} min`;
  }
  return `${minutes}m ${seconds}s`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function deriveTheme(state) {
  if (!state.timerVisible || state.clockMode) {
    return "normal";
  }
  if (state.timerMode === "countup") {
    return "normal";
  }
  const remainingSeconds = Math.ceil(state.remainingMs / 1000);
  if (remainingSeconds <= 0) {
    return "finished";
  }
  if (remainingSeconds <= state.dangerThresholdSeconds) {
    return "danger";
  }
  if (remainingSeconds <= state.warningThresholdSeconds) {
    return "warning";
  }
  return "normal";
}

function displayMs(state) {
  return state.timerMode === "countup" ? state.countupMs : state.remainingMs;
}

/* ── Room context ────────────────────────────────────────────────────────── */

// A Show's URLs look like /s/<id>/dashboard or /s/<id>/stage. The older /r/<id>
// prefix is an accepted alias so links shared before the rename keep working.
// The bare /dashboard and /stage drive the default Show ("main"); for them
// API_BASE is empty so those legacy routes are unchanged.
const ROOM_MATCH = window.location.pathname.match(/^\/([rs])\/([a-z0-9]+)(?:\/|$)/i);
const ROOM_PREFIX = ROOM_MATCH ? ROOM_MATCH[1].toLowerCase() : "s";
const ROOM_ID = ROOM_MATCH ? ROOM_MATCH[2].toLowerCase() : "main";
// Keep whichever prefix the page was opened with, so API calls hit the same
// route the browser is on (both /r/ and /s/ resolve to the same Show).
const API_BASE = ROOM_MATCH ? `/${ROOM_PREFIX}/${ROOM_ID}` : "";

/* ── Control API ─────────────────────────────────────────────────────────── */

const PASSCODE_KEY = "stageTimer.passcode";

function storedPasscode() {
  try {
    return window.localStorage.getItem(PASSCODE_KEY) || "";
  } catch (_) {
    return "";
  }
}

function rememberPasscode(value) {
  try {
    window.localStorage.setItem(PASSCODE_KEY, value);
  } catch (_) {
    /* private mode — the passcode just won't persist */
  }
}

// Every mutating call goes through here: it attaches the stored passcode,
// prompts once on a 401 and retries, and surfaces server error messages.
async function controlFetch(url, { method = "POST", body } = {}, allowPrompt = true) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const passcode = storedPasscode();
  if (passcode) headers["x-control-passcode"] = passcode;

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  if (response.status === 401 && allowPrompt) {
    const entered = window.prompt("Control passcode:");
    if (entered && entered.trim()) {
      rememberPasscode(entered.trim());
      return controlFetch(url, { method, body }, false);
    }
    throw new Error("Passcode required");
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await response.json();
      if (payload && payload.error) message = payload.error;
    } catch (_) {
      /* keep the generic message */
    }
    throw new Error(message);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function postState(body) {
  return controlFetch(`${API_BASE}/api/state`, { method: "POST", body });
}

/* ── Shows API ───────────────────────────────────────────────────────────── */
// A "Show" is one independent timer. The server calls it a room internally, so
// these still hit /api/rooms.

function createShow(body) {
  return controlFetch("/api/rooms", { method: "POST", body });
}

async function listShows() {
  const data = await controlFetch("/api/rooms", { method: "GET" });
  return data && Array.isArray(data.rooms) ? data.rooms : [];
}

/* ── Live state client ───────────────────────────────────────────────────── */

// No message and no heartbeat for this long means the stream is dead even if
// the browser has not told us so yet.
const STALE_AFTER_MS = 25000;
const TICK_MS = 100;

/**
 * Holds the last server snapshot and advances it locally against the browser's
 * monotonic clock. The display therefore keeps counting through a network drop
 * instead of freezing on the last packet, and server messages only correct drift.
 */
function createTimerClient({ onState, onTick, onNotFound }) {
  let snapshot = null;
  let anchor = 0;
  let lastMessageAt = performance.now();
  let connected = false;
  let source = null;
  let closed = false;
  let notFound = false;

  function live() {
    if (!snapshot) return null;
    const elapsed = snapshot.running ? Math.max(0, performance.now() - anchor) : 0;
    const isCountup = snapshot.timerMode === "countup";
    const remainingMs = isCountup ? snapshot.remainingMs : Math.max(0, snapshot.remainingMs - elapsed);
    const countupMs = isCountup ? snapshot.countupMs + elapsed : snapshot.countupMs;

    return {
      ...snapshot,
      remainingMs,
      countupMs,
      running: snapshot.running && !(!isCountup && remainingMs === 0)
    };
  }

  function status() {
    return {
      connected,
      stale: performance.now() - lastMessageAt > STALE_AFTER_MS,
      hasState: Boolean(snapshot)
    };
  }

  function apply(next) {
    snapshot = next;
    anchor = performance.now();
    lastMessageAt = anchor;
    connected = true;
    if (onState) onState(live(), status());
    if (onTick) onTick(live(), status());
  }

  function connect() {
    if (closed || notFound) return;
    source = new EventSource(`${API_BASE}/events`);

    source.onopen = () => {
      connected = true;
      lastMessageAt = performance.now();
    };
    source.onmessage = (event) => {
      try {
        apply(JSON.parse(event.data));
      } catch (err) {
        console.error("Bad state payload:", err);
      }
    };
    source.addEventListener("ping", () => {
      lastMessageAt = performance.now();
      connected = true;
    });
    source.onerror = () => {
      connected = false;
    };
  }

  // The initial fetch is authoritative for existence. A 404 means the room id
  // is unknown, so we stop rather than let EventSource hammer a missing route.
  fetch(`${API_BASE}/api/state`)
    .then((response) => {
      if (response.status === 404) {
        notFound = true;
        if (onNotFound) onNotFound();
        return null;
      }
      return response.json();
    })
    .then((state) => {
      if (state && !snapshot) apply(state);
      connect();
    })
    .catch(() => {
      // Network hiccup, not a 404 — rely on the event stream to recover.
      connect();
    });

  // EventSource reconnects on its own, but once it lands in CLOSED it never
  // retries. Venue wifi produces exactly that often enough to matter.
  const watchdog = setInterval(() => {
    if (closed || notFound) return;
    if (!source || source.readyState === 2) {
      connected = false;
      try {
        if (source) source.close();
      } catch (_) {
        /* already gone */
      }
      connect();
    }
  }, 3000);

  const ticker = setInterval(() => {
    if (onTick) onTick(live(), status());
  }, TICK_MS);

  return {
    live,
    status,
    close() {
      closed = true;
      clearInterval(ticker);
      clearInterval(watchdog);
      try {
        if (source) source.close();
      } catch (_) {
        /* already gone */
      }
    }
  };
}

/* ── Dashboard ───────────────────────────────────────────────────────────── */

const TIMEZONE_SHORTLIST = [
  "Asia/Singapore", "Asia/Bangkok", "Asia/Jakarta", "Asia/Kuala_Lumpur", "Asia/Manila",
  "Asia/Ho_Chi_Minh", "Asia/Hong_Kong", "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul",
  "Asia/Taipei", "Asia/Kolkata", "Asia/Dubai", "Australia/Sydney", "Australia/Perth",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Amsterdam", "Europe/Madrid",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "UTC"
];

function allTimeZones() {
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      return Intl.supportedValuesOf("timeZone");
    }
  } catch (_) {
    /* fall through to the shortlist */
  }
  return TIMEZONE_SHORTLIST;
}

function bindDashboard() {
  const timerReadout = document.querySelector("[data-timer-readout]");
  const statusPill = document.querySelector("[data-status-pill]");
  const stageValue = document.querySelector("[data-stage-value]");
  const durationValue = document.querySelector("[data-duration-value]");
  const warningValue = document.querySelector("[data-warning-value]");
  const messageValue = document.querySelector("[data-message-value]");
  const blinkEnabledInput = document.querySelector("#blinkEnabled");
  const showSessionToggleBtn = document.querySelector("[data-show-session-toggle]");
  const showTimeBtn = document.querySelector("[data-show-time]");
  const queueSpeakerNameInput = document.querySelector("#queueSpeakerName");
  const queueDurationInput = document.querySelector("#queueDurationMinutes");
  const queueWarningThresholdInput = document.querySelector("#queueWarningThreshold");
  const queueList = document.querySelector("[data-queue-list]");
  const queuePanelBody = document.querySelector("[data-queue-panel-body]");
  const queueToggle = document.querySelector("[data-queue-toggle]");
  const alertMicBtn = document.querySelector("[data-alert-mic]");
  const alertVoiceBtn = document.querySelector("[data-alert-voice]");
  const alertWrapupBtn = document.querySelector("[data-alert-wrapup]");
  const liveMessageInput = document.querySelector("#liveMessage");
  const liveMessageButton = document.querySelector("[data-send-message]");
  const countupStatus = document.querySelector("[data-countup-status]");
  const connectionBanner = document.querySelector("[data-connection-banner]");
  const toast = document.querySelector("[data-toast]");
  const timeZoneSelect = document.querySelector("#timeZoneSelect");
  const clockFormatSelect = document.querySelector("#clockFormatSelect");
  const clockPreview = document.querySelector("[data-clock-preview]");
  const detectedZoneLabel = document.querySelector("[data-detected-zone]");
  const roomNameEl = document.querySelector("[data-room-name]");
  const roomMissing = document.querySelector("[data-room-missing]");
  const stageLinks = document.querySelectorAll("a.stage-link");
  const previewIframe = document.querySelector(".stage-preview-iframe");

  let latestState = null;
  let liveMessageDraftDirty = false;
  let queueCollapsed = false;
  let queueSignature = null;
  let timeZoneAutoSent = false;
  let toastTimer = null;

  // Point the "Open Stage" links and the live preview at this room.
  stageLinks.forEach((a) => a.setAttribute("href", `${API_BASE}/stage`));
  if (previewIframe && API_BASE) previewIframe.src = `${API_BASE}/stage`;

  const detected = detectedTimeZone();
  if (detectedZoneLabel) detectedZoneLabel.textContent = detected || "unknown";

  if (timeZoneSelect) {
    const zones = allTimeZones();
    const options = ['<option value="">Use each display’s own time</option>'];
    for (const zone of zones) {
      const label = zone === detected ? `${zone} (this device)` : zone;
      options.push(`<option value="${escapeHtml(zone)}">${escapeHtml(label)}</option>`);
    }
    timeZoneSelect.innerHTML = options.join("");
  }

  function showToast(message, kind = "error") {
    if (!toast) return;
    toast.textContent = message;
    toast.dataset.kind = kind;
    toast.dataset.visible = "true";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.dataset.visible = "false";
    }, 4000);
  }

  // Every control routes through here so a failed request is always visible to
  // the operator rather than silently doing nothing.
  async function send(body, description) {
    try {
      await postState(body);
    } catch (err) {
      console.error(description, err);
      showToast(`${description} failed — ${err.message}`);
    }
  }

  const sendAction = (action, description) => send({ action }, description);

  function refreshLiveMessageButton(state) {
    const currentState = state || latestState;
    const draft = liveMessageInput.value.trim();

    if (!currentState || !currentState.customMessage || draft !== currentState.customMessage) {
      liveMessageButton.textContent = "Send Message";
      return;
    }

    liveMessageButton.textContent = currentState.messageVisible ? "Hide Message" : "Unhide Message";
  }

  function renderQueue(state) {
    const signature = JSON.stringify(state.queuedSpeakers) + String(queueCollapsed);
    if (signature === queueSignature) return;
    queueSignature = signature;

    queuePanelBody.hidden = queueCollapsed;
    queueToggle.textContent = queueCollapsed ? "Expand Queue" : "Collapse Queue";

    queueList.innerHTML = state.queuedSpeakers.length === 0
      ? '<div class="queue-empty">No sessions queued yet.</div>'
      : state.queuedSpeakers
          .map((speaker, index) => `
            <article class="queue-item">
              <div>
                <span class="queue-index">${index + 1}</span>
                <strong>${escapeHtml(speaker.sessionLabel || speaker.speakerName || "Untitled Session")}</strong>
                <span class="queue-duration">${escapeHtml(formatDuration(speaker.totalSeconds))}</span>
                <span class="queue-threshold">${escapeHtml(`Warn at ${speaker.warningThresholdSeconds}s`)}</span>
              </div>
              <div class="queue-actions">
                <button class="secondary" type="button" data-queue-load="${escapeHtml(speaker.id)}">Load</button>
                <button class="secondary" type="button" data-queue-up="${escapeHtml(speaker.id)}">Up</button>
                <button class="secondary" type="button" data-queue-down="${escapeHtml(speaker.id)}">Down</button>
                <button class="danger" type="button" data-queue-remove="${escapeHtml(speaker.id)}">Delete</button>
              </div>
            </article>
          `)
          .join("");
  }

  const client = createTimerClient({
    // Fires only when the server sends new state — safe place for full redraws
    // and for anything that would fight with the operator's typing.
    onState(state) {
      try {
        latestState = state;

        if (roomNameEl && state.roomName) roomNameEl.textContent = state.roomName;
        stageValue.textContent = state.sessionLabel;
        durationValue.textContent = state.timerMode === "countup" ? "Count Up" : formatDuration(state.totalSeconds);
        if (warningValue) warningValue.textContent = `${state.warningThresholdSeconds}s`;
        if (messageValue) {
          messageValue.textContent = state.customMessage
            ? state.messageVisible ? state.customMessage : "Hidden"
            : "None";
          messageValue.dataset.hiddenState = String(!!state.customMessage && !state.messageVisible);
        }

        if (alertMicBtn) alertMicBtn.dataset.active = String(state.activeAlert === "mic");
        if (alertVoiceBtn) alertVoiceBtn.dataset.active = String(state.activeAlert === "voice");
        if (alertWrapupBtn) alertWrapupBtn.dataset.active = String(state.activeAlert === "wrapup");
        if (blinkEnabledInput) blinkEnabledInput.checked = !!state.blinkEnabled;
        if (showSessionToggleBtn) showSessionToggleBtn.dataset.active = String(!!state.showSessionLabel);
        if (showTimeBtn) showTimeBtn.textContent = state.clockMode ? "Hide Clock" : "Show Clock";

        if (timeZoneSelect && document.activeElement !== timeZoneSelect) {
          timeZoneSelect.value = state.timeZone || "";
        }
        if (clockFormatSelect && document.activeElement !== clockFormatSelect) {
          clockFormatSelect.value = state.clockFormat || "24h";
        }

        // Nothing has ever set a timezone: adopt the operator's, which is
        // almost always the event's, and push it to every display.
        if (!timeZoneAutoSent && !state.timeZone && detected) {
          timeZoneAutoSent = true;
          send({ timeZone: detected }, "Setting time zone");
        }

        if (!liveMessageDraftDirty && document.activeElement !== liveMessageInput) {
          liveMessageInput.value = state.customMessage;
        }
        refreshLiveMessageButton(state);
        renderQueue(state);
      } catch (err) {
        console.error("Dashboard state update error:", err);
      }
    },

    // Runs 10x a second off locally-advanced state.
    onTick(state, status) {
      if (connectionBanner) {
        const degraded = !status.connected || status.stale;
        connectionBanner.dataset.visible = String(degraded);
        if (degraded) {
          connectionBanner.textContent = status.hasState
            ? "Lost connection to the timer server — the stage display is running on its own clock. Reconnecting…"
            : "Connecting to the timer server…";
        }
      }

      if (!state) return;

      if (state.clockMode) {
        if (timerReadout) timerReadout.textContent = formatWallClock(state);
      } else if (timerReadout) {
        timerReadout.textContent = state.timerVisible ? formatClock(displayMs(state)) : "--:--";
      }

      if (statusPill) {
        statusPill.textContent = state.timerMode === "countup"
          ? state.running ? "Count Up Live" : "Count Up Ready"
          : state.running ? "Running live" : state.remainingMs === 0 ? "Time elapsed" : "Paused";
      }

      if (countupStatus) {
        countupStatus.textContent = state.timerMode === "countup"
          ? state.running ? "Active on stage" : "Ready on stage"
          : "Inactive";
      }

      if (clockPreview) clockPreview.textContent = formatWallClock(state);

      document.body.dataset.theme = deriveTheme(state);
    },

    onNotFound() {
      if (roomMissing) roomMissing.dataset.visible = "true";
    }
  });

  document.querySelector("[data-start]").addEventListener("click", () => sendAction("start", "Start"));
  document.querySelector("[data-pause]").addEventListener("click", () => sendAction("pause", "Pause"));
  document.querySelector("[data-reset]").addEventListener("click", () => sendAction("reset", "Reset"));
  document.querySelector("[data-stop]").addEventListener("click", () => sendAction("stop", "Stop"));
  document.querySelector("[data-add-minute]").addEventListener("click", () => sendAction("addMinute", "Add 1 min"));
  document.querySelector("[data-subtract-minute]").addEventListener("click", () => sendAction("subtractMinute", "Subtract 1 min"));
  document.querySelector("[data-add-five-minutes]").addEventListener("click", () => sendAction("addFiveMinutes", "Add 5 min"));
  document.querySelector("[data-subtract-five-minutes]").addEventListener("click", () => sendAction("subtractFiveMinutes", "Subtract 5 min"));

  // Driven off state rather than toggled locally, so the label can never lie
  // about what the stage is showing.
  showTimeBtn.addEventListener("click", () => {
    const next = !(latestState && latestState.clockMode);
    send({ action: "setClockMode", clockMode: next }, "Clock toggle");
  });

  if (timeZoneSelect) {
    timeZoneSelect.addEventListener("change", () => {
      timeZoneAutoSent = true;
      send({ timeZone: timeZoneSelect.value || null }, "Setting time zone");
    });
  }

  if (clockFormatSelect) {
    clockFormatSelect.addEventListener("change", () => {
      send({ clockFormat: clockFormatSelect.value }, "Setting clock format");
    });
  }

  if (blinkEnabledInput) {
    blinkEnabledInput.addEventListener("change", () => {
      send({ blinkEnabled: blinkEnabledInput.checked }, "Blink setting");
    });
  }

  if (showSessionToggleBtn) {
    showSessionToggleBtn.addEventListener("click", () => {
      const next = showSessionToggleBtn.dataset.active !== "true";
      send({ showSessionLabel: next }, "Session label toggle");
    });
  }

  document.querySelector("[data-queue-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await postState({
        action: "addQueuedSpeaker",
        queueSpeakerName: queueSpeakerNameInput.value,
        queueSpeakerSeconds: Number(queueDurationInput.value) * 60,
        queueWarningThresholdSeconds: Number(queueWarningThresholdInput.value)
      });
      queueSpeakerNameInput.value = "";
      queueDurationInput.value = "15";
      queueWarningThresholdInput.value = "120";
      queueSpeakerNameInput.focus();
    } catch (err) {
      showToast(`Could not add session — ${err.message}`);
    }
  });

  document.querySelector("[data-queue-load-now]").addEventListener("click", async () => {
    try {
      await postState({
        action: "loadNow",
        queueSpeakerName: queueSpeakerNameInput.value,
        queueSpeakerSeconds: Number(queueDurationInput.value) * 60,
        queueWarningThresholdSeconds: Number(queueWarningThresholdInput.value)
      });
      queueSpeakerNameInput.value = "";
      queueDurationInput.value = "15";
      queueWarningThresholdInput.value = "120";
    } catch (err) {
      showToast(`Could not load session — ${err.message}`);
    }
  });

  queueToggle.addEventListener("click", () => {
    queueCollapsed = !queueCollapsed;
    queuePanelBody.hidden = queueCollapsed;
    queueToggle.textContent = queueCollapsed ? "Expand Queue" : "Collapse Queue";
  });

  document.querySelector("[data-queue-clear]").addEventListener("click", () => {
    if (!confirm("Clear all queued sessions?")) return;
    send({ action: "clearQueue" }, "Clear queue");
  });

  liveMessageInput.addEventListener("input", () => {
    liveMessageDraftDirty = true;
    refreshLiveMessageButton();
  });

  liveMessageButton.addEventListener("click", async () => {
    const draft = liveMessageInput.value.trim();
    const currentState = latestState;

    if (!currentState || !currentState.customMessage || draft !== currentState.customMessage) {
      await send({ action: "sendMessage", messageText: draft }, "Send message");
    } else if (currentState.messageVisible) {
      await send({ action: "hideMessage" }, "Hide message");
    } else {
      await send({ action: "unhideMessage" }, "Unhide message");
    }
    liveMessageDraftDirty = false;
  });

  function bindAlertButton(button, action, description) {
    if (!button) return;
    button.addEventListener("click", () => {
      const isActive = button.dataset.active === "true";
      send({ action: isActive ? "clearAlert" : action }, description);
    });
  }

  bindAlertButton(alertMicBtn, "showMicAlert", "Mic alert");
  bindAlertButton(alertVoiceBtn, "showVoiceAlert", "Voice alert");
  bindAlertButton(alertWrapupBtn, "showWrapupAlert", "Wrap-up alert");

  document.querySelector("[data-clear-message]").addEventListener("click", async () => {
    liveMessageInput.value = "";
    await send({ action: "clearMessage" }, "Clear message");
    liveMessageDraftDirty = false;
    refreshLiveMessageButton();
  });

  queueList.addEventListener("click", (event) => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest("button[data-queue-load], button[data-queue-up], button[data-queue-down], button[data-queue-remove]")
      : null;
    if (!target) return;

    const { queueLoad, queueUp, queueDown, queueRemove } = target.dataset;

    if (queueLoad) {
      send({ action: "loadQueuedSpeaker", queueSpeakerId: queueLoad }, "Load session");
    } else if (queueUp) {
      send({ action: "moveQueuedSpeaker", queueSpeakerId: queueUp, direction: "up" }, "Move session");
    } else if (queueDown) {
      send({ action: "moveQueuedSpeaker", queueSpeakerId: queueDown, direction: "down" }, "Move session");
    } else if (queueRemove) {
      send({ action: "removeQueuedSpeaker", queueSpeakerId: queueRemove }, "Remove session");
    }
  });

  document.querySelector("[data-countup-start]").addEventListener("click", () => sendAction("startCountup", "Count up start"));
  document.querySelector("[data-countup-pause]").addEventListener("click", () => sendAction("pauseCountup", "Count up pause"));
  document.querySelector("[data-countup-reset]").addEventListener("click", () => sendAction("resetCountup", "Count up reset"));

  const previewWrapper = document.querySelector(".stage-preview-wrapper");
  if (previewWrapper && previewIframe) {
    const scalePreview = () => {
      const scale = previewWrapper.clientWidth / 1920;
      previewIframe.style.transform = `scale(${scale})`;
    };
    new ResizeObserver(scalePreview).observe(previewWrapper);
    scalePreview();
  }

  window.addEventListener("beforeunload", () => client.close());
}

/* ── Stage display ───────────────────────────────────────────────────────── */

// The stage screen must not sleep mid-session.
function keepScreenAwake() {
  if (!("wakeLock" in navigator)) return;
  let lock = null;

  const acquire = async () => {
    try {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => {
        lock = null;
      });
    } catch (_) {
      /* denied or unsupported — nothing else we can do */
    }
  };

  void acquire();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !lock) void acquire();
  });
}

function bindStage() {
  const shell = document.querySelector("[data-stage-shell]");
  const timer = document.querySelector("[data-stage-timer]");
  const clockOverlay = document.querySelector("[data-stage-clock]");
  const clockTime = document.querySelector("[data-stage-clock-time]");
  const session = document.querySelector("[data-stage-session]");
  const message = document.querySelector("[data-stage-message]");
  const alertOverlay = document.querySelector("[data-stage-alert-overlay]");
  const alertCard = document.querySelector("[data-stage-alert-card]");
  const alertHeadline = document.querySelector("[data-stage-alert-headline]");
  const alertSub = document.querySelector("[data-stage-alert-sub]");
  const linkDot = document.querySelector("[data-stage-link-status]");
  const roomMissing = document.querySelector("[data-room-missing]");

  let prevAlertType = null;
  let alertAnimating = false;
  let alertDismissTimer = null;
  let lastTimerText = null;
  let lastClockText = null;
  let lastThemeClass = null;
  let fittedFor = null;

  const ALERT_CONTENT = {
    mic: { headline: "Hold Mic Closer" },
    voice: { headline: "Project Your Voice" },
    wrapup: { headline: "Please Wrap Up" }
  };

  // Bundled locally — the stage must render identically on a venue network
  // with no internet at all.
  const motionAnimate = window.Motion && typeof window.Motion.animate === "function"
    ? window.Motion.animate
    : null;

  let resizeFitTimer = null;

  function fitTimerFont() {
    // Binary-search for the largest px font-size whose rendered text fits within
    // the centre area — 96% of its width AND 92% of its height. Crucially there
    // is NO absolute cap: the size is bound only by the viewport, so the timer
    // fills the same proportion of the screen at any resolution. That is what
    // makes a 4K stage match the dashboard preview (a scaled 1920×1080 iframe)
    // instead of shrinking to a fixed pixel size on high-res displays.
    const parent = timer.parentElement;
    const maxWidth = parent.clientWidth * 0.96;
    const maxHeight = parent.clientHeight * 0.92;
    if (!maxWidth || !maxHeight) return;
    const range = document.createRange();
    range.selectNodeContents(timer);
    let lo = 16;
    let hi = Math.ceil(window.innerHeight * 1.5); // generous upper bound, never a fixed pixel cap
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      timer.style.fontSize = `${mid}px`;
      const rect = range.getBoundingClientRect();
      if (rect.width <= maxWidth && rect.height <= maxHeight) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    timer.style.fontSize = `${lo}px`;
    clockOverlay.style.fontSize = `${lo}px`;
  }

  // Refit whenever the string gets wider (a count-up passing 99:59, say),
  // not just once on first paint.
  function fitFor(text) {
    const key = `${text.length}|${window.innerWidth}x${window.innerHeight}`;
    if (key === fittedFor) return;
    fittedFor = key;
    fitTimerFont();
  }

  window.addEventListener("resize", () => {
    if (resizeFitTimer) clearTimeout(resizeFitTimer);
    resizeFitTimer = setTimeout(() => {
      fittedFor = null;
      if (lastTimerText !== null) fitFor(lastTimerText);
    }, 150);
  });

  // Re-run once webfonts land, since the fit depends on real glyph metrics.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      fittedFor = null;
      if (lastTimerText !== null) fitFor(lastTimerText);
    }).catch(() => {});
  }

  function showAlert(type, remainingMs) {
    if (alertDismissTimer) {
      clearTimeout(alertDismissTimer);
      alertDismissTimer = null;
    }
    const content = ALERT_CONTENT[type] || {};
    alertHeadline.textContent = content.headline || "";
    alertSub.textContent = content.sub || "";
    alertOverlay.dataset.alert = type;
    alertOverlay.dataset.active = "true";

    if (motionAnimate) {
      motionAnimate(alertCard,
        { opacity: [0, 1], scale: [0.6, 1], y: ["60px", "0px"] },
        { duration: 0.6, ease: [0.16, 1, 0.3, 1] }
      );
    }

    // Anchored to a duration from the server, not to a shared wall clock.
    const ttl = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : 7000;
    alertDismissTimer = setTimeout(() => {
      alertDismissTimer = null;
      prevAlertType = null;
      void hideAlert();
    }, ttl);
  }

  async function hideAlert() {
    if (alertDismissTimer) {
      clearTimeout(alertDismissTimer);
      alertDismissTimer = null;
    }
    if (alertAnimating) return;
    alertAnimating = true;
    try {
      if (motionAnimate) {
        await motionAnimate(alertCard,
          { opacity: [1, 0], scale: [1, 0.82], y: ["0px", "30px"] },
          { duration: 0.35, ease: [0.4, 0, 1, 1] }
        );
      }
    } catch (_) {
      // animation interrupted — still close the overlay
    } finally {
      alertOverlay.dataset.active = "false";
      alertAnimating = false;
    }
  }

  const client = createTimerClient({
    onState(state) {
      shell.dataset.blinkEnabled = String(state.blinkEnabled);

      if (session) {
        session.textContent = state.sessionLabel;
        session.dataset.visible = String(!!state.showSessionLabel);
      }
      message.textContent = state.customMessage;
      message.dataset.visible = String(state.messageVisible && !!state.customMessage);

      if (state.activeAlert !== prevAlertType) {
        if (state.activeAlert) {
          showAlert(state.activeAlert, state.alertRemainingMs);
        } else {
          void hideAlert();
        }
        prevAlertType = state.activeAlert;
      }
    },

    onTick(state, status) {
      // Deliberately subtle: the speaker must never be distracted by an
      // infrastructure warning, but the operator glancing over should see it.
      if (linkDot) {
        linkDot.dataset.visible = String(status.hasState && (!status.connected || status.stale));
      }

      if (!state) return;

      const themeClass = `stage-frame theme-${deriveTheme(state)}`;
      if (themeClass !== lastThemeClass) {
        shell.className = themeClass;
        lastThemeClass = themeClass;
      }

      const timerText = formatClock(displayMs(state));
      if (timerText !== lastTimerText) {
        timer.textContent = timerText;
        lastTimerText = timerText;
        fitFor(timerText);
      }
      timer.dataset.hidden = String(!state.timerVisible);

      if (state.clockMode) {
        clockOverlay.dataset.active = "true";
        const clockText = formatWallClock(state);
        if (clockText !== lastClockText) {
          clockTime.textContent = clockText;
          lastClockText = clockText;
        }
      } else {
        clockOverlay.dataset.active = "false";
      }
    },

    onNotFound() {
      if (roomMissing) roomMissing.dataset.visible = "true";
    }
  });

  keepScreenAwake();

  window.addEventListener("beforeunload", () => {
    client.close();
    if (resizeFitTimer) clearTimeout(resizeFitTimer);
  });
}

/* ── Lobby ───────────────────────────────────────────────────────────────── */

// Rooms this browser has created or opened, so the lobby can list them without
// the server having to hand out every room link (which would need the passcode).
const RECENT_ROOMS_KEY = "stageTimer.recentRooms";

function loadRecentRooms() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_ROOMS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function rememberRoom(entry) {
  try {
    const list = loadRecentRooms().filter((r) => r.id !== entry.id);
    list.unshift(entry);
    window.localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(list.slice(0, 30)));
  } catch (_) {
    /* private mode — recent list just won't persist */
  }
}

function forgetRoom(id) {
  try {
    window.localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(loadRecentRooms().filter((r) => r.id !== id)));
  } catch (_) {
    /* ignore */
  }
}

// Checks a passcode against the server WITHOUT the 401 prompt in controlFetch.
// GET /api/rooms is passcode-gated and read-only, so a 200 means the passcode
// is correct (and, when no passcode is configured, it's open and returns 200).
async function verifyPasscode(pass) {
  try {
    const res = await fetch("/api/rooms", { headers: pass ? { "x-control-passcode": pass } : {} });
    return res.status === 200;
  } catch (_) {
    return false;
  }
}

function bindLobby() {
  const createForm = document.querySelector("[data-create-room]");
  const roomNameInput = document.querySelector("#newRoomName");
  const roomList = document.querySelector("[data-room-list]");
  const toast = document.querySelector("[data-toast]");
  const showAllBtn = document.querySelector("[data-show-all-rooms]");
  const gate = document.querySelector("[data-lobby-gate]");
  const gateForm = document.querySelector("[data-lobby-gate-form]");
  const gateInput = document.querySelector("#lobbyPassword");
  const gateError = document.querySelector("[data-lobby-gate-error]");
  let toastTimer = null;
  let opened = false;

  function showToast(message, kind = "error") {
    if (!toast) return;
    toast.textContent = message;
    toast.dataset.kind = kind;
    toast.dataset.visible = "true";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.dataset.visible = "false"; }, 4000);
  }

  function showCard(show) {
    const name = escapeHtml(show.name || "Untitled Show");
    const id = escapeHtml(show.id);
    return `
      <article class="room-card">
        <div class="room-card-head">
          <strong>${name}</strong>
          <span class="room-id">${id}</span>
        </div>
        <div class="room-card-links">
          <a class="primary" href="/s/${id}/dashboard">Open Controls</a>
          <a class="secondary" href="/s/${id}/stage" target="_blank" rel="noreferrer">Stage</a>
          <button class="secondary" type="button" data-copy-stage="${id}">Copy Stage Link</button>
          <button class="danger" type="button" data-forget="${id}">Remove</button>
        </div>
      </article>`;
  }

  function renderRecent() {
    const recent = loadRecentRooms();
    roomList.innerHTML = recent.length === 0
      ? '<div class="queue-empty">No Shows on this device yet. Create one above.</div>'
      : recent.map(showCard).join("");
  }

  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = (roomNameInput.value || "").trim();
    try {
      const show = await createShow({ name });
      rememberRoom({ id: show.id, name: show.name, createdAt: Date.now() });
      window.location.href = `/s/${show.id}/dashboard`;
    } catch (err) {
      showToast(`Could not create Show — ${err.message}`);
    }
  });

  roomList.addEventListener("click", async (event) => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest("button[data-copy-stage], button[data-forget]")
      : null;
    if (!target) return;

    const copyId = target.dataset.copyStage;
    const forgetId = target.dataset.forget;

    if (copyId) {
      const link = `${window.location.origin}/s/${copyId}/stage`;
      try {
        await navigator.clipboard.writeText(link);
        showToast("Stage link copied", "info");
      } catch (_) {
        window.prompt("Copy this stage link:", link);
      }
    } else if (forgetId) {
      forgetRoom(forgetId);
      renderRecent();
    }
  });

  if (showAllBtn) {
    showAllBtn.addEventListener("click", async () => {
      try {
        const serverShows = await listShows();
        for (const s of serverShows) {
          if (s.id !== "main") rememberRoom({ id: s.id, name: s.name, createdAt: s.updatedAt || Date.now() });
        }
        renderRecent();
        showToast(`Loaded ${serverShows.length} Show(s) from the server`, "info");
      } catch (err) {
        showToast(`Could not list Shows — ${err.message}`);
      }
    });
  }

  /* ── Password gate ── */
  function openLobby() {
    if (opened) return;
    opened = true;
    if (gate) gate.hidden = true;
    renderRecent();
  }

  if (gateForm) {
    gateForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const entered = (gateInput.value || "").trim();
      if (!entered) return;
      if (await verifyPasscode(entered)) {
        rememberPasscode(entered);
        if (gateError) gateError.hidden = true;
        openLobby();
      } else {
        if (gateError) gateError.hidden = false;
        gateInput.select();
      }
    });
  }

  (async () => {
    // Skip the gate entirely if no passcode is configured on the server.
    let required = true;
    try {
      const cfg = await (await fetch("/api/config")).json();
      required = Boolean(cfg.passcodeRequired);
    } catch (_) {
      /* assume gated on error — fail closed for the view */
    }
    if (!required || (await verifyPasscode(storedPasscode()))) {
      openLobby();
    } else if (gateInput) {
      gateInput.focus();
    }
  })();
}

if (document.body.matches(".lobby-body")) {
  bindLobby();
}

if (document.body.matches(".dashboard-body")) {
  bindDashboard();
}

if (document.body.matches(".stage-body")) {
  bindStage();
}
