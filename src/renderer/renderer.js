import {
  chooseBestAudioInputDevice,
  listAudioDevices,
  setPreferredDeviceId,
} from "./core/device-manager.js";
import { AudioEngine } from "./core/audio-engine.js";
import { RecorderController, STATES } from "./core/recorder-controller.js";
import {
  formatError,
  microphoneStatusForError,
  serializeError,
  userMessageForFailure,
} from "./core/error-utils.js";

const MIN_RECORDING_DURATION_MS = 100;
let controller;
let runtimeConfig = null;

function updateStatus(message, color) {
  const statusElement = document.getElementById("status");
  if (!statusElement) return;
  statusElement.textContent = message;
  const colors = {
    red: "var(--recording)",
    blue: "var(--working)",
    green: "var(--done)",
    black: "var(--ink)",
  };
  statusElement.style.color = colors[color] || color;
}

function sendDiagnostics(payload) {
  window.electronAPI?.sendDiagnostics?.(payload);
}

function platformShortcutDisplay(shortcut) {
  if (!shortcut) return "";
  if (navigator.platform.toLowerCase().includes("mac")) {
    return shortcut
      .replace("CommandOrControl", "\u2318")
      .replace("Shift", "\u21e7")
      .replace("Space", "Space")
      .replace(/\+/g, " + ");
  }
  return shortcut.replace("CommandOrControl", "Ctrl");
}

function renderRuntimeConfig(config) {
  runtimeConfig = config;
  const runtimeInfo = document.getElementById("runtimeInfo");
  const hotkeyHint = document.getElementById("hotkeyHint");
  const dictationShortcut = config.shortcutOk === false
    ? "Dictation shortcut unavailable"
    : `${platformShortcutDisplay(config.registeredShortcut || config.shortcut)} dictates`;
  const commandShortcut = config.commandShortcutOk === false
    ? "Command shortcut unavailable"
    : `${platformShortcutDisplay(config.registeredCommandShortcut || config.commandShortcut)} edits selection`;
  if (runtimeInfo) {
    runtimeInfo.textContent = `ASR: ${config.model} | Text: ${config.textModel} | Dictation: ${config.dictationMode} | Dictionary: ${(config.dictionaryTerms || []).length}`;
  }
  if (hotkeyHint) {
    hotkeyHint.textContent = `${dictationShortcut} | ${commandShortcut}`;
  }
}

function applyRuntimeConfig(config) {
  renderRuntimeConfig(config);
  if (controller) {
    controller.setPreviewIntervalMs(config.previewIntervalMs);
    controller.setDoneHideWindowMs(config.doneHideWindowMs);
    controller.setDictationMode(config.dictationMode);
  }
}

function renderMode(mode) {
  const chip = document.getElementById("modeChip");
  if (!chip) return;
  chip.textContent = mode === "command" ? "Command" : "Dictation";
}

function truncateMiddle(text, maxLength) {
  if (!text || text.length <= maxLength) return text || "";
  return `${text.slice(0, Math.floor(maxLength / 2))} ... ${text.slice(-Math.floor(maxLength / 2))}`;
}

function updatePreview(text, { mode = "dictation", phase = "preview", selectedText = "", selection, previewParts = 0 } = {}) {
  renderMode(mode);
  const previewMeta = document.getElementById("previewMeta");
  const previewText = document.getElementById("previewText");
  const selectedElement = document.getElementById("selectedText");

  if (selectedElement) {
    const shouldShowSelection = mode === "command" && selectedText;
    selectedElement.style.display = shouldShowSelection ? "block" : "none";
    if (shouldShowSelection) {
      selectedElement.textContent = `Selection captured (${selectedText.length} chars): ${truncateMiddle(selectedText, 160)}`;
    } else if (mode === "command") {
      selectedElement.style.display = "block";
      selectedElement.textContent = selection?.ok === false
        ? `No selection captured: ${selection.error || "copy failed"}`
        : "No selection captured. Command will generate new text.";
    } else {
      selectedElement.textContent = "";
    }
  }

  if (previewMeta) {
    const labels = {
      recording: mode === "command" ? "Listening for command" : "Listening",
      preview: mode === "command"
        ? "Command preview"
        : previewParts > 1
          ? `Live preview (${previewParts} parts)`
          : "Live preview",
      final: mode === "command" ? "Command heard" : "Final transcript",
      polished: "Polished transcript",
      result: "Rewrite result",
      recovering: "Recovering",
      error: "Needs retry",
    };
    previewMeta.textContent = labels[phase] || "Preview";
  }

  if (previewText) {
    if (text && text.trim()) {
      previewText.textContent = text.trim();
    } else if (phase === "recording") {
      previewText.textContent = "Listening...";
    } else {
      previewText.textContent = "Waiting for speech.";
    }
  }
}

function updateRecoveryActions(payload = null) {
  const root = document.getElementById("recoveryActions");
  const copyPartial = document.getElementById("copyPartial");
  const copyCommand = document.getElementById("copyRecoveryCommand");
  const retryRecovery = document.getElementById("retryRecovery");
  const retryMic = document.getElementById("retryMic");
  const testMic = document.getElementById("testMic");
  const retryPaste = document.getElementById("retryPaste");
  const copyOutput = document.getElementById("copyOutput");
  const openSettings = document.getElementById("openSettings");
  if (!root || !copyPartial || !copyCommand || !retryRecovery) return;

  const shouldShow = Boolean(payload?.show);
  root.style.display = shouldShow ? "flex" : "none";
  retryRecovery.style.display = payload?.savedAudio || payload?.target ? "inline-block" : "none";
  copyPartial.style.display = payload?.copyPartial || payload?.partialText ? "inline-block" : "none";
  copyCommand.style.display = payload?.copyCommand || payload?.command ? "inline-block" : "none";
  if (retryMic) retryMic.style.display = payload?.retryMic ? "inline-block" : "none";
  if (testMic) testMic.style.display = payload?.testMic ? "inline-block" : "none";
  if (retryPaste) retryPaste.style.display = payload?.retryPaste ? "inline-block" : "none";
  if (copyOutput) copyOutput.style.display = payload?.copyOutput ? "inline-block" : "none";
  if (openSettings) openSettings.style.display = payload?.settings ? "inline-block" : "none";
}

async function refreshMicSelection() {
  if (!controller) return { ok: false, error: "not initialized" };
  try {
    await controller.requestMicrophoneAccess();
    await controller.audioEngine.ensureStream({ forceRefresh: true });
    const device = controller.audioEngine.getActiveDevice();
    updateStatus(`Mic updated (${device.label})`, "black");
    updateRecoveryActions(null);
    sendDiagnostics({
      type: "mic-refresh",
      status: "ok",
      label: device.label,
      deviceId: device.id,
    });
    return { ok: true, label: device.label, deviceId: device.id };
  } catch (error) {
    const errorText = formatError(error);
    console.error(`Mic refresh failed: ${errorText}`);
    updateStatus(microphoneStatusForError(error), "red");
    updateRecoveryActions({
      show: true,
      retryMic: true,
      testMic: true,
      settings: true,
    });
    sendDiagnostics({ type: "mic-refresh", status: "error", error: serializeError(error) });
    return { ok: false, error: errorText };
  }
}

async function testMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    const microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);
    analyser.fftSize = 256;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    let detected = false;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
      if (average > 10) detected = true;
    }

    stream.getTracks().forEach((track) => track.stop());
    await audioContext.close();

    if (detected) {
      updateStatus("Microphone is working", "green");
      updateRecoveryActions(null);
      return { detected: true };
    }
    updateStatus("No audio detected", "red");
    updateRecoveryActions({
      show: true,
      retryMic: true,
      testMic: true,
      settings: true,
    });
    return { detected: false };
  } catch (error) {
    const errorText = formatError(error);
    console.error(`Error testing microphone: ${errorText}`);
    updateStatus(microphoneStatusForError(error), "red");
    updateRecoveryActions({
      show: true,
      retryMic: true,
      testMic: true,
      settings: true,
    });
    return { detected: false, error: errorText };
  }
}

async function boot() {
  const runtimeConfig = await window.electronAPI.getRuntimeConfig();
  const isMac = navigator.platform.toLowerCase().includes("mac");
  applyRuntimeConfig(runtimeConfig);
  const audioEngine = new AudioEngine({
    chooseDevice: chooseBestAudioInputDevice,
    setPreferredDeviceId,
    onDiagnostics: sendDiagnostics,
  });

  controller = new RecorderController({
    audioEngine,
    minRecordingDurationMs: MIN_RECORDING_DURATION_MS,
    mediaRecorderTimesliceMs: runtimeConfig.recorderTimesliceMs || 150,
    doneHideWindowMs: runtimeConfig.doneHideWindowMs || 900,
    hideWindow: isMac ? () => window.electronAPI.hideWindow() : null,
    scheduleHideWindow: (delayMs) => window.electronAPI.scheduleHideWindow(delayMs),
    cancelHideWindow: () => window.electronAPI.cancelHideWindow(),
    focusRestoreDelayMs: isMac ? 180 : 60,
    requestMicrophoneAccess: () => window.electronAPI.requestMicrophoneAccess(),
    transcribeAudio: (arrayBuffer) => window.electronAPI.transcribeAudio(arrayBuffer),
    transcribePreview: (arrayBuffer) => window.electronAPI.transcribePreview(arrayBuffer),
    transcribeAudioChunked: (arrayBuffers) => window.electronAPI.transcribeAudioChunked(arrayBuffers),
    retryRecovery: (target, options) => window.electronAPI.retryRecovery(target, options),
    deleteRecovery: (target) => window.electronAPI.deleteRecovery(target),
    polishDictation: (payload) => window.electronAPI.polishDictation(payload),
    processCommand: (payload) => window.electronAPI.processCommand(payload),
    simulateTyping: (text) => window.electronAPI.simulateTyping(text),
    copyText: (text) => window.electronAPI.copyText(text),
    updateStatus,
    updatePreview,
    updateRecoveryActions,
    onDiagnostics: sendDiagnostics,
  });
  controller.setPreviewIntervalMs(runtimeConfig.previewIntervalMs);
  controller.setDictationMode(runtimeConfig.dictationMode);

  try {
    await controller.initialize();
    if (runtimeConfig.apiKeyOk === false) {
      updateStatus("API key missing", "red");
      updatePreview("Set GROQ_API_KEY before recording.", { phase: "error" });
      updateRecoveryActions({ show: true, settings: true });
      sendDiagnostics({ type: "api-key-missing" });
    }
  } catch (error) {
    const errorText = formatError(error);
    console.error(`Failed to initialize recorder: ${errorText}`);
    sendDiagnostics({ type: "mic-init-error", error: serializeError(error) });
    updateStatus(microphoneStatusForError(error), "red");
    updatePreview(userMessageForFailure(error, "Microphone is not ready."), { phase: "error" });
    updateRecoveryActions({
      show: true,
      retryMic: true,
      testMic: true,
      settings: true,
    });
  }

  const audioDevices = await listAudioDevices().catch(() => []);
  if (audioDevices.length) {
    const compactDevices = audioDevices.map((d) =>
      (d.label || d.deviceId || "unlabeled").slice(0, 40)
    );
    sendDiagnostics({
      type: "audio-devices",
      count: audioDevices.length,
      devices: compactDevices,
    });
  }

  window.electronAPI.onToggleRecording((payload = {}) => {
    updateRecoveryActions(null);
    if (runtimeConfig?.apiKeyOk === false) {
      updateStatus("API key missing", "red");
      updatePreview("Set GROQ_API_KEY before recording.", {
        mode: payload.mode || "dictation",
        phase: "error",
        selectedText: payload.selectedText || "",
        selection: payload.selection,
      });
      updateRecoveryActions({ show: true, settings: true });
      sendDiagnostics({ type: "api-key-missing" });
      window.electronAPI.showWindow?.();
      return;
    }
    controller.toggleRecording(payload).catch((error) => {
      console.error("Toggle failed:", error);
      updateStatus("Toggle failed", "red");
    });
  });

  document.getElementById("retryRecovery")?.addEventListener("click", () => {
    controller.retrySavedRecovery().catch((error) => {
      console.error("Manual recovery retry failed:", error);
      updateStatus("Retry failed", "red");
    });
  });

  document.getElementById("copyPartial")?.addEventListener("click", () => {
    controller.copyRecoveryPartial().catch((error) => {
      console.error("Copy partial failed:", error);
      updateStatus("Copy failed", "red");
    });
  });

  document.getElementById("copyRecoveryCommand")?.addEventListener("click", () => {
    controller.copyRecoveryCommand().catch((error) => {
      console.error("Copy command failed:", error);
      updateStatus("Copy failed", "red");
    });
  });

  document.getElementById("retryMic")?.addEventListener("click", () => {
    refreshMicSelection();
  });

  document.getElementById("testMic")?.addEventListener("click", () => {
    testMicrophone();
  });

  document.getElementById("openSettings")?.addEventListener("click", () => {
    window.electronAPI.openSettings?.();
  });

  document.getElementById("retryPaste")?.addEventListener("click", () => {
    controller.retryLastPaste().catch((error) => {
      console.error(`Retry paste failed: ${formatError(error)}`);
      updateStatus("Retry paste failed", "red");
    });
  });

  document.getElementById("copyOutput")?.addEventListener("click", () => {
    controller.copyLastOutput().catch((error) => {
      console.error(`Copy text failed: ${formatError(error)}`);
      updateStatus("Copy failed", "red");
    });
  });

  window.electronAPI.onTypingProgress?.((progress = {}) => {
    if (progress.total > 1) {
      updateStatus(`Inserting ${progress.index}/${progress.total}...`, "green");
    }
  });

  window.electronAPI.onRuntimeConfigUpdated?.((nextConfig) => {
    applyRuntimeConfig(nextConfig);
  });

  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    if (controller.getState() === STATES.RECORDING) return;
    refreshMicSelection();
  });

  window.electronAPI.onRefreshMic(async () => {
    const result = await refreshMicSelection();
    window.electronAPI.sendRefreshMicResult(result);
  });

  window.electronAPI.onTestMic(async () => {
    const result = await testMicrophone();
    window.electronAPI.sendTestMicResult(result);
  });

  window.electronAPI.onRetryPaste(async (text) => {
    try {
      await window.electronAPI.simulateTyping(text);
    } catch (error) {
      console.error("Retry paste failed:", error);
    }
  });

  window.electronAPI.onListDevices(async () => {
    const devices = await listAudioDevices().catch(() => []);
    window.electronAPI.sendListDevicesResult({
      devices: devices.map((d) => ({
        label: d.label || "unknown",
        deviceId: d.deviceId || "unknown",
      })),
    });
  });
}

boot().catch((error) => {
  console.error("Renderer boot failed:", error);
  updateStatus("Boot failed", "red");
});
