import {
  chooseBestAudioInputDevice,
  getPreferredDeviceId,
  listAudioDevices,
  setPreferredDeviceId,
} from "./core/device-manager.js";
import { AudioEngine } from "./core/audio-engine.js";
import { RecorderController, STATES } from "./core/recorder-controller.js";

const MIN_RECORDING_DURATION_MS = 100;
let controller;
let runtimeConfig = null;

function updateStatus(message, color) {
  const statusElement = document.getElementById("status");
  if (!statusElement) return;
  statusElement.textContent = message;
  statusElement.style.color = color;
}

function sendDiagnostics(payload) {
  window.electronAPI?.sendDiagnostics?.(payload);
}

function platformShortcutDisplay(shortcut) {
  if (!shortcut) return "";
  if (navigator.platform.toLowerCase().includes("mac")) {
    return shortcut
      .replace("CommandOrControl", "⌘")
      .replace("Shift", "⇧")
      .replace("Space", "Space")
      .replace(/\+/g, " + ");
  }
  return shortcut.replace("CommandOrControl", "Ctrl");
}

function renderRuntimeConfig(config) {
  runtimeConfig = config;
  const runtimeInfo = document.getElementById("runtimeInfo");
  const hotkeyHint = document.getElementById("hotkeyHint");
  if (runtimeInfo) {
    runtimeInfo.textContent = `Model: ${config.model} | Timeout: ${config.timeoutMs}ms | Queue: ${config.maxQueue} | Slice: ${config.recorderTimesliceMs}ms`;
  }
  if (hotkeyHint) {
    hotkeyHint.textContent = `Press ${platformShortcutDisplay(config.shortcut)} to start/stop recording`;
  }

  const hotkeyInput = document.getElementById("hotkeyInput");
  if (hotkeyInput) hotkeyInput.value = config.shortcut || "";
  const injectionModeSelect = document.getElementById("injectionModeSelect");
  if (injectionModeSelect) injectionModeSelect.value = config.clipboardRestoreMode || "deferred";
  const modelSelect = document.getElementById("modelSelect");
  if (modelSelect) modelSelect.value = config.model || "whisper-large-v3-turbo";
}

async function refreshMicSelection() {
  if (!controller) return;
  try {
    await controller.requestMicrophoneAccess();
    await controller.audioEngine.ensureStream({ forceRefresh: true });
    const device = controller.audioEngine.getActiveDevice();
    updateStatus(`Mic updated (${device.label})`, "black");
    sendDiagnostics({
      type: "mic-refresh",
      status: "ok",
      label: device.label,
      deviceId: device.id,
    });
  } catch (error) {
    console.error("Mic refresh failed:", error);
    updateStatus("Mic update failed", "red");
    sendDiagnostics({ type: "mic-refresh", status: "error" });
  }
}

async function refreshMicSourceOptions() {
  const micSourceSelect = document.getElementById("micSourceSelect");
  if (!micSourceSelect) return;

  const preferred = getPreferredDeviceId();
  const devices = await listAudioDevices().catch(() => []);
  micSourceSelect.innerHTML = "";

  const autoOption = document.createElement("option");
  autoOption.value = "";
  autoOption.textContent = "Auto";
  micSourceSelect.appendChild(autoOption);

  devices.forEach((device) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `Device (${device.deviceId})`;
    micSourceSelect.appendChild(option);
  });

  micSourceSelect.value = preferred || "";
}

async function applyRuntimeSettings(patch) {
  try {
    const next = await window.electronAPI.updateRuntimeSettings(patch);
    renderRuntimeConfig(next);
    controller.mediaRecorderTimesliceMs = next.recorderTimesliceMs || controller.mediaRecorderTimesliceMs;
    updateStatus("Settings applied", "black");
  } catch (error) {
    console.error("Failed to apply settings:", error);
    updateStatus("Settings apply failed", "red");
  }
}

function resolveProfile(profile) {
  if (profile === "fast") {
    return {
      model: "whisper-large-v3-turbo",
      clipboardRestoreMode: "off",
      recorderTimesliceMs: 100,
    };
  }

  if (profile === "balanced") {
    return {
      model: "whisper-large-v3",
      clipboardRestoreMode: "deferred",
      recorderTimesliceMs: 150,
    };
  }

  return null;
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
    } else {
      updateStatus("No audio detected", "red");
    }
  } catch (error) {
    console.error("Error testing microphone:", error);
    updateStatus("Mic test failed", "red");
  }
}

async function boot() {
  const runtimeConfig = await window.electronAPI.getRuntimeConfig();
  const isMac = navigator.platform.toLowerCase().includes("mac");
  renderRuntimeConfig(runtimeConfig);

  const audioEngine = new AudioEngine({
    chooseDevice: chooseBestAudioInputDevice,
    setPreferredDeviceId,
    onDiagnostics: sendDiagnostics,
  });

  controller = new RecorderController({
    audioEngine,
    minRecordingDurationMs: MIN_RECORDING_DURATION_MS,
    mediaRecorderTimesliceMs: runtimeConfig.recorderTimesliceMs || 150,
    hideWindow: () => window.electronAPI.hideWindow(),
    focusRestoreDelayMs: isMac ? 180 : 60,
    requestMicrophoneAccess: () => window.electronAPI.requestMicrophoneAccess(),
    transcribeAudio: (arrayBuffer) => window.electronAPI.transcribeAudio(arrayBuffer),
    simulateTyping: (text) => window.electronAPI.simulateTyping(text),
    updateStatus,
    onDiagnostics: sendDiagnostics,
  });

  try {
    await controller.initialize();
  } catch (error) {
    console.error("Failed to initialize recorder:", error);
    updateStatus("Initialization failed", "red");
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
  await refreshMicSourceOptions();

  window.electronAPI.onToggleRecording(() => {
    controller.toggleRecording().catch((error) => {
      console.error("Toggle failed:", error);
      updateStatus("Toggle failed", "red");
    });
  });

  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    if (controller.getState() === STATES.RECORDING) return;
    refreshMicSelection();
  });

  const testMicButton = document.getElementById("testMicButton");
  if (testMicButton) testMicButton.addEventListener("click", testMicrophone);

  const refreshMicButton = document.getElementById("refreshMicButton");
  if (refreshMicButton) refreshMicButton.addEventListener("click", refreshMicSelection);

  const injectionModeSelect = document.getElementById("injectionModeSelect");
  if (injectionModeSelect) {
    injectionModeSelect.addEventListener("change", () => {
      applyRuntimeSettings({ clipboardRestoreMode: injectionModeSelect.value });
    });
  }

  const micSourceSelect = document.getElementById("micSourceSelect");
  if (micSourceSelect) {
    micSourceSelect.addEventListener("change", async () => {
      setPreferredDeviceId(micSourceSelect.value || "");
      await refreshMicSelection();
    });
  }

  const applyHotkeyButton = document.getElementById("applyHotkeyButton");
  if (applyHotkeyButton) {
    applyHotkeyButton.addEventListener("click", () => {
      const hotkeyInput = document.getElementById("hotkeyInput");
      const shortcut = hotkeyInput?.value?.trim();
      if (!shortcut) return;
      applyRuntimeSettings({ shortcut });
    });
  }

  const applyProfileButton = document.getElementById("applyProfileButton");
  if (applyProfileButton) {
    applyProfileButton.addEventListener("click", () => {
      const profile = document.getElementById("profileSelect")?.value || "custom";
      const model = document.getElementById("modelSelect")?.value || runtimeConfig.model;
      const patch = resolveProfile(profile) || { model };
      if (!patch.model) patch.model = model;
      applyRuntimeSettings(patch);
    });
  }
}

boot().catch((error) => {
  console.error("Renderer boot failed:", error);
  updateStatus("Boot failed", "red");
});
