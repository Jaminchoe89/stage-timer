function formatWallClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
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

async function postState(body) {
  const response = await fetch("/api/state", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error("Failed to update timer state");
  }

  return response.json();
}

function subscribeToState(handleState) {
  let snapshot = null;

  function publish(state) {
    snapshot = state;
    handleState(state);
  }

  fetch("/api/state")
    .then((response) => response.json())
    .then(publish)
    .catch((error) => console.error(error));

  const source = new EventSource("/events");
  source.onmessage = (event) => {
    publish(JSON.parse(event.data));
  };

  return {
    close() {
      source.close();
    },
    getSnapshot() {
      return snapshot;
    }
  };
}

function bindDashboard() {
  const timerReadout = document.querySelector("[data-timer-readout]");
  const statusPill = document.querySelector("[data-status-pill]");
  const stageValue = document.querySelector("[data-stage-value]");
  const durationValue = document.querySelector("[data-duration-value]");
  const messageValue = document.querySelector("[data-message-value]");
  const sessionInput = document.querySelector("#sessionLabel");
  const durationInput = document.querySelector("#durationMinutes");
  const warningInput = document.querySelector("#warningThreshold");
  const blinkEnabledInput = document.querySelector("#blinkEnabled");
  const showSessionLabelInput = document.querySelector("#showSessionLabel");
  const countupSessionLabelInput = document.querySelector("#countupSessionLabel");
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
  let latestState = null;
  let liveMessageDraftDirty = false;
  let queueCollapsed = true;
  let dashClockInterval = null;

  function syncField(input, value) {
    if (document.activeElement !== input) {
      input.value = value;
    }
  }

  function refreshLiveMessageButton(state) {
    const currentState = state || latestState;
    const draft = liveMessageInput.value.trim();

    if (!currentState || !currentState.customMessage || draft !== currentState.customMessage) {
      liveMessageButton.textContent = "Send Message";
      return;
    }

    liveMessageButton.textContent = currentState.messageVisible ? "Hide Message" : "Unhide Message";
  }

  const sub = subscribeToState((state) => {
    try {
      latestState = state;
      const theme = deriveTheme(state);
      if (state.clockMode) {
        if (!dashClockInterval) {
          dashClockInterval = setInterval(() => { timerReadout.textContent = formatWallClock(); }, 1000);
        }
        timerReadout.textContent = formatWallClock();
      } else {
        if (dashClockInterval) { clearInterval(dashClockInterval); dashClockInterval = null; }
        timerReadout.textContent = state.timerVisible ? formatClock(displayMs(state)) : "--:--";
      }
      statusPill.textContent = state.timerMode === "countup"
        ? state.running ? "Count Up Live" : "Count Up Ready"
        : state.running ? "Running live" : state.remainingMs === 0 ? "Time elapsed" : "Paused";
      stageValue.textContent = state.sessionLabel;
      durationValue.textContent = state.timerMode === "countup" ? "Count Up" : formatDuration(state.totalSeconds);
      messageValue.textContent = state.customMessage
        ? state.messageVisible ? state.customMessage : "Hidden"
        : "None";
      messageValue.dataset.hiddenState = String(!!state.customMessage && !state.messageVisible);
      countupStatus.textContent = state.timerMode === "countup"
        ? state.running ? "Active on stage" : "Ready on stage"
        : "Inactive";

      if (alertMicBtn) alertMicBtn.dataset.active = String(state.activeAlert === "mic");
      if (alertVoiceBtn) alertVoiceBtn.dataset.active = String(state.activeAlert === "voice");
      if (alertWrapupBtn) alertWrapupBtn.dataset.active = String(state.activeAlert === "wrapup");
      syncField(sessionInput, state.sessionLabel);
      syncField(countupSessionLabelInput, state.countupSessionLabel);
      syncField(durationInput, String(Math.max(1, Math.round(state.totalSeconds / 60))));
      syncField(warningInput, String(state.warningThresholdSeconds));
      blinkEnabledInput.checked = state.blinkEnabled;
      showSessionLabelInput.checked = !!state.showSessionLabel;
      if (!liveMessageDraftDirty && document.activeElement !== liveMessageInput) {
        liveMessageInput.value = state.customMessage;
      }
      refreshLiveMessageButton(state);
      document.body.dataset.theme = theme;
      document.body.dataset.blinkEnabled = String(state.blinkEnabled);
      queuePanelBody.hidden = queueCollapsed;
      queueToggle.textContent = queueCollapsed ? "Expand Queue" : "Collapse Queue";

      queueList.innerHTML = state.queuedSpeakers.length === 0
        ? '<div class="queue-empty">No speakers queued yet.</div>'
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
                  <button class="secondary" type="button" data-queue-load="${speaker.id}">Load</button>
                  <button class="secondary" type="button" data-queue-up="${speaker.id}">Up</button>
                  <button class="secondary" type="button" data-queue-down="${speaker.id}">Down</button>
                  <button class="danger" type="button" data-queue-remove="${speaker.id}">Delete</button>
                </div>
              </article>
            `)
            .join("");
    } catch (err) {
      console.error("Dashboard state update error:", err);
    }
  });

  async function sendAction(action) {
    await postState({ action });
  }

  document.querySelector("[data-start]").addEventListener("click", () => sendAction("start"));
  document.querySelector("[data-pause]").addEventListener("click", () => sendAction("pause"));
  document.querySelector("[data-reset]").addEventListener("click", () => sendAction("reset"));
  document.querySelector("[data-stop]").addEventListener("click", () => sendAction("stop"));
  document.querySelector("[data-add-minute]").addEventListener("click", () => sendAction("addMinute"));
  document.querySelector("[data-subtract-minute]").addEventListener("click", () => sendAction("subtractMinute"));
  document.querySelector("[data-add-five-minutes]").addEventListener("click", () => sendAction("addFiveMinutes"));
  document.querySelector("[data-subtract-five-minutes]").addEventListener("click", () => sendAction("subtractFiveMinutes"));
  document.querySelector("[data-show-time]").addEventListener("click", () => sendAction("showTime"));

  document.querySelector("[data-settings-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    await postState({
      sessionLabel: sessionInput.value,
      totalSeconds: Number(durationInput.value) * 60,
      warningThresholdSeconds: Number(warningInput.value),
      blinkEnabled: blinkEnabledInput.checked
    });
  });

  blinkEnabledInput.addEventListener("change", async () => {
    await postState({ blinkEnabled: blinkEnabledInput.checked });
  });

  showSessionLabelInput.addEventListener("change", async () => {
    await postState({ showSessionLabel: showSessionLabelInput.checked });
  });

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
      alert("Could not add session — make sure the session label is filled in.");
    }
  });

  queueToggle.addEventListener("click", () => {
    queueCollapsed = !queueCollapsed;
    queuePanelBody.hidden = queueCollapsed;
    queueToggle.textContent = queueCollapsed ? "Expand Queue" : "Collapse Queue";
  });

  document.querySelector("[data-queue-clear]").addEventListener("click", async () => {
    if (!confirm("Clear all queued sessions?")) return;
    const state = sub.getSnapshot();
    if (!state || !state.queuedSpeakers) return;
    for (const speaker of [...state.queuedSpeakers]) {
      await postState({ action: "removeQueuedSpeaker", queueSpeakerId: speaker.id });
    }
  });

  liveMessageInput.addEventListener("input", () => {
    liveMessageDraftDirty = true;
    refreshLiveMessageButton();
  });

  liveMessageButton.addEventListener("click", async () => {
    const draft = liveMessageInput.value.trim();
    const currentState = latestState || sub.getSnapshot();

    if (!currentState || !currentState.customMessage || draft !== currentState.customMessage) {
      await postState({ action: "sendMessage", messageText: draft });
    } else if (currentState.messageVisible) {
      await postState({ action: "hideMessage" });
    } else {
      await postState({ action: "unhideMessage" });
    }
    liveMessageDraftDirty = false;
  });

  alertMicBtn.addEventListener("click", () => {
    if (alertMicBtn.dataset.active === "true") {
      alertMicBtn.dataset.active = "false";
      sendAction("clearAlert");
    } else {
      alertMicBtn.dataset.active = "true";
      alertVoiceBtn.dataset.active = "false";
      alertWrapupBtn.dataset.active = "false";
      sendAction("showMicAlert");
    }
  });
  alertVoiceBtn.addEventListener("click", () => {
    if (alertVoiceBtn.dataset.active === "true") {
      alertVoiceBtn.dataset.active = "false";
      sendAction("clearAlert");
    } else {
      alertVoiceBtn.dataset.active = "true";
      alertMicBtn.dataset.active = "false";
      alertWrapupBtn.dataset.active = "false";
      sendAction("showVoiceAlert");
    }
  });

  alertWrapupBtn.addEventListener("click", () => {
    if (alertWrapupBtn.dataset.active === "true") {
      alertWrapupBtn.dataset.active = "false";
      sendAction("clearAlert");
    } else {
      alertWrapupBtn.dataset.active = "true";
      alertMicBtn.dataset.active = "false";
      alertVoiceBtn.dataset.active = "false";
      sendAction("showWrapupAlert");
    }
  });

  document.querySelector("[data-clear-message]").addEventListener("click", async () => {
    liveMessageInput.value = "";
    await postState({ action: "clearMessage" });
    liveMessageDraftDirty = false;
    refreshLiveMessageButton();
  });

  queueList.addEventListener("click", async (event) => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest("button[data-queue-load], button[data-queue-up], button[data-queue-down], button[data-queue-remove]")
      : null;
    if (!target) return;

    const loadId = target.dataset.queueLoad;
    const upId = target.dataset.queueUp;
    const downId = target.dataset.queueDown;
    const removeId = target.dataset.queueRemove;

    if (loadId) {
      await postState({ action: "loadQueuedSpeaker", queueSpeakerId: loadId });
    } else if (upId) {
      await postState({ action: "moveQueuedSpeaker", queueSpeakerId: upId, direction: "up" });
    } else if (downId) {
      await postState({ action: "moveQueuedSpeaker", queueSpeakerId: downId, direction: "down" });
    } else if (removeId) {
      await postState({ action: "removeQueuedSpeaker", queueSpeakerId: removeId });
    }
  });

  document.querySelector("[data-countup-start]").addEventListener("click", async () => {
    await postState({
      countupSessionLabel: countupSessionLabelInput.value,
      action: "startCountup"
    });
  });
  document.querySelector("[data-countup-pause]").addEventListener("click", () => sendAction("pauseCountup"));
  document.querySelector("[data-countup-reset]").addEventListener("click", async () => {
    await postState({
      countupSessionLabel: countupSessionLabelInput.value,
      action: "resetCountup"
    });
  });

  window.addEventListener("beforeunload", () => { sub.close(); if (dashClockInterval) clearInterval(dashClockInterval); });
}

function bindStage() {
  const shell = document.querySelector("[data-stage-shell]");
  const timer = document.querySelector("[data-stage-timer]");
  const session = document.querySelector("[data-stage-session]");
  const message = document.querySelector("[data-stage-message]");
  const alertOverlay = document.querySelector("[data-stage-alert-overlay]");
  const alertCard = document.querySelector("[data-stage-alert-card]");
  const alertHeadline = document.querySelector("[data-stage-alert-headline]");
  const alertSub = document.querySelector("[data-stage-alert-sub]");
  let clockInterval = null;
  let prevAlertType = null;
  let alertAnimating = false;
  let alertDismissTimer = null;

  const ALERT_CONTENT = {
    mic:    { headline: "Hold Mic Closer",   sub: "Bring your microphone closer to your mouth" },
    voice:  { headline: "Project Your Voice", sub: "Speak up — let your voice fill the room" },
    wrapup: { headline: "Please Wrap Up",    sub: "Begin wrapping up your session" }
  };

  let motionAnimate = null;
  import("https://cdn.jsdelivr.net/npm/motion@latest/+esm")
    .then((mod) => { motionAnimate = mod.animate; })
    .catch(() => {});

  function showAlert(type, expiresAt) {
    if (alertDismissTimer) { clearTimeout(alertDismissTimer); alertDismissTimer = null; }
    const content = ALERT_CONTENT[type] || {};
    alertHeadline.textContent = content.headline || "";
    alertSub.textContent = content.sub || "";
    alertOverlay.dataset.alert = type;
    alertOverlay.dataset.active = "true";
    if (motionAnimate) {
      motionAnimate(alertCard,
        { opacity: [0, 1], scale: [0.6, 1], y: ["60px", "0px"] },
        { duration: 0.6, easing: [0.16, 1, 0.3, 1] }
      );
    }
    if (expiresAt) {
      alertDismissTimer = setTimeout(() => {
        alertDismissTimer = null;
        prevAlertType = null;
        hideAlert();
      }, Math.max(0, expiresAt - Date.now()));
    }
  }

  async function hideAlert() {
    if (alertDismissTimer) { clearTimeout(alertDismissTimer); alertDismissTimer = null; }
    if (alertAnimating) return;
    alertAnimating = true;
    if (motionAnimate) {
      await motionAnimate(alertCard,
        { opacity: [1, 0], scale: [1, 0.82], y: ["0px", "30px"] },
        { duration: 0.35, easing: [0.4, 0, 1, 1] }
      ).finished;
    }
    alertOverlay.dataset.active = "false";
    alertAnimating = false;
  }

  const sub = subscribeToState((state) => {
    const theme = deriveTheme(state);
    shell.className = `stage-frame theme-${theme}`;
    shell.dataset.blinkEnabled = String(state.blinkEnabled);
    if (session) {
      session.textContent = state.sessionLabel;
      session.dataset.visible = String(!!state.showSessionLabel);
    }
    message.textContent = state.customMessage;
    message.dataset.visible = String(state.messageVisible && !!state.customMessage);

    if (state.clockMode) {
      if (!clockInterval) {
        clockInterval = setInterval(() => { timer.textContent = formatWallClock(); }, 1000);
      }
      timer.textContent = formatWallClock();
      timer.dataset.hidden = "false";
    } else {
      if (clockInterval) {
        clearInterval(clockInterval);
        clockInterval = null;
      }
      timer.textContent = formatClock(displayMs(state));
      timer.dataset.hidden = String(!state.timerVisible);
    }

    if (state.activeAlert !== prevAlertType) {
      if (state.activeAlert) {
        showAlert(state.activeAlert, state.alertExpiresAt);
      } else {
        hideAlert();
      }
      prevAlertType = state.activeAlert;
    }
  });

  window.addEventListener("beforeunload", () => { sub.close(); if (clockInterval) clearInterval(clockInterval); });
}

if (document.body.matches(".dashboard-body")) {
  bindDashboard();
}

if (document.body.matches(".stage-body")) {
  bindStage();
}
