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
  let latestState = null;
  let liveMessageDraftDirty = false;
  let queueCollapsed = false;
  let dashClockInterval = null;

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
          dashClockInterval = setInterval(() => { if (timerReadout) timerReadout.textContent = formatWallClock(); }, 1000);
        }
        if (timerReadout) timerReadout.textContent = formatWallClock();
      } else {
        if (dashClockInterval) { clearInterval(dashClockInterval); dashClockInterval = null; }
        if (timerReadout) timerReadout.textContent = state.timerVisible ? formatClock(displayMs(state)) : "--:--";
      }
      if (statusPill) statusPill.textContent = state.timerMode === "countup"
        ? state.running ? "Count Up Live" : "Count Up Ready"
        : state.running ? "Running live" : state.remainingMs === 0 ? "Time elapsed" : "Paused";
      stageValue.textContent = state.sessionLabel;
      durationValue.textContent = state.timerMode === "countup" ? "Count Up" : formatDuration(state.totalSeconds);
      if (warningValue) warningValue.textContent = `${state.warningThresholdSeconds}s`;
      if (messageValue) {
        messageValue.textContent = state.customMessage
          ? state.messageVisible ? state.customMessage : "Hidden"
          : "None";
        messageValue.dataset.hiddenState = String(!!state.customMessage && !state.messageVisible);
      }
      countupStatus.textContent = state.timerMode === "countup"
        ? state.running ? "Active on stage" : "Ready on stage"
        : "Inactive";

      if (alertMicBtn) alertMicBtn.dataset.active = String(state.activeAlert === "mic");
      if (alertVoiceBtn) alertVoiceBtn.dataset.active = String(state.activeAlert === "voice");
      if (alertWrapupBtn) alertWrapupBtn.dataset.active = String(state.activeAlert === "wrapup");
      if (blinkEnabledInput) blinkEnabledInput.checked = !!state.blinkEnabled;
      if (showSessionToggleBtn) showSessionToggleBtn.dataset.active = String(!!state.showSessionLabel);
      if (showTimeBtn) showTimeBtn.textContent = state.clockMode ? "Hide Clock" : "Show Clock";
      if (!liveMessageDraftDirty && document.activeElement !== liveMessageInput) {
        liveMessageInput.value = state.customMessage;
      }
      refreshLiveMessageButton(state);
      document.body.dataset.theme = theme;
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
  showTimeBtn.addEventListener("click", () => {
    const next = showTimeBtn.textContent === "Show Clock";
    showTimeBtn.textContent = next ? "Hide Clock" : "Show Clock";
    sendAction("showTime");
  });


  if (blinkEnabledInput) {
    blinkEnabledInput.addEventListener("change", async () => {
      await postState({ blinkEnabled: blinkEnabledInput.checked });
    });
  }

  if (showSessionToggleBtn) {
    showSessionToggleBtn.addEventListener("click", async () => {
      const next = showSessionToggleBtn.dataset.active !== "true";
      await postState({ showSessionLabel: next });
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
      alert("Could not add session — make sure duration is set.");
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
      alert("Could not load session — make sure duration is set.");
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

  document.querySelector("[data-countup-start]").addEventListener("click", () => sendAction("startCountup"));
  document.querySelector("[data-countup-pause]").addEventListener("click", () => sendAction("pauseCountup"));
  document.querySelector("[data-countup-reset]").addEventListener("click", () => sendAction("resetCountup"));

  const previewWrapper = document.querySelector(".stage-preview-wrapper");
  const previewIframe = document.querySelector(".stage-preview-iframe");
  if (previewWrapper && previewIframe) {
    const scalePreview = () => {
      const scale = previewWrapper.clientWidth / 1920;
      previewIframe.style.transform = `scale(${scale})`;
    };
    new ResizeObserver(scalePreview).observe(previewWrapper);
    scalePreview();
  }

  window.addEventListener("beforeunload", () => { sub.close(); if (dashClockInterval) clearInterval(dashClockInterval); });
}

function bindStage() {
  const shell = document.querySelector("[data-stage-shell]");
  const timer = document.querySelector("[data-stage-timer]");
  const clockOverlay = document.querySelector("[data-stage-clock]");
  const clockTime = document.querySelector("[data-stage-clock-time]");
  clockTime.style.color = '#7dd3fc';
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
    mic:    { headline: "Hold Mic Closer" },
    voice:  { headline: "Project Your Voice" },
    wrapup: { headline: "Please Wrap Up" }
  };

  let motionAnimate = null;
  import("https://cdn.jsdelivr.net/npm/motion@latest/+esm")
    .then((mod) => { motionAnimate = mod.animate; })
    .catch(() => {});

  let resizeFitTimer = null;
  let timerFontFitted = false;

  function fitTimerFont() {
    // Binary-search for the largest px font-size whose rendered text width
    // fits within 96% of the container — works regardless of font metrics.
    const targetWidth = timer.parentElement.clientWidth * 0.96;
    const range = document.createRange();
    range.selectNodeContents(timer);
    let lo = 48, hi = 480;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      timer.style.fontSize = mid + 'px';
      if (range.getBoundingClientRect().width <= targetWidth) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    timer.style.fontSize = lo + 'px';
    clockOverlay.style.fontSize = lo + 'px';
    timerFontFitted = true;
  }

  window.addEventListener('resize', () => {
    if (resizeFitTimer) clearTimeout(resizeFitTimer);
    resizeFitTimer = setTimeout(fitTimerFont, 150);
  });

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
    try {
      if (motionAnimate) {
        await motionAnimate(alertCard,
          { opacity: [1, 0], scale: [1, 0.82], y: ["0px", "30px"] },
          { duration: 0.35, easing: [0.4, 0, 1, 1] }
        ).finished;
      }
    } catch (_) {
      // animation interrupted — still close the overlay
    } finally {
      alertOverlay.dataset.active = "false";
      alertAnimating = false;
    }
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

    timer.textContent = formatClock(displayMs(state));
    timer.dataset.hidden = String(!state.timerVisible);

    if (state.clockMode) {
      clockOverlay.dataset.active = "true";
      if (!clockInterval) {
        clockInterval = setInterval(() => { clockTime.textContent = formatWallClock(); }, 1000);
      }
      clockTime.textContent = formatWallClock();
    } else {
      clockOverlay.dataset.active = "false";
      if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
    }

    if (!timerFontFitted) fitTimerFont();

    if (state.activeAlert !== prevAlertType) {
      if (state.activeAlert) {
        showAlert(state.activeAlert, state.alertExpiresAt);
      } else {
        hideAlert();
      }
      prevAlertType = state.activeAlert;
    }
  });

  window.addEventListener("beforeunload", () => { sub.close(); if (clockInterval) clearInterval(clockInterval); resizeFitTimer && clearTimeout(resizeFitTimer); });
}

if (document.body.matches(".dashboard-body")) {
  bindDashboard();
}

if (document.body.matches(".stage-body")) {
  bindStage();
}
