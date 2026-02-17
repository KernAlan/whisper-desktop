import {
  chooseBestAudioInputDevice,
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
  if (runtimeInfo) {
    runtimeInfo.textContent = `Model: ${config.model} | Timeout: ${config.timeoutMs}ms | Queue: ${config.maxQueue} | Slice: ${config.recorderTimesliceMs}ms`;
  }
  if (hotkeyHint) {
    hotkeyHint.textContent = `Press ${platformShortcutDisplay(config.shortcut)} to start/stop recording`;
  }
}

async function refreshMicSelection() {
  if (!controller) return { ok: false, error: "not initialized" };
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
    return { ok: true, label: device.label, deviceId: device.id };
  } catch (error) {
    console.error("Mic refresh failed:", error);
    updateStatus("Mic update failed", "red");
    sendDiagnostics({ type: "mic-refresh", status: "error" });
    return { ok: false, error: error.message };
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
      return { detected: true };
    }
    updateStatus("No audio detected", "red");
    return { detected: false };
  } catch (error) {
    console.error("Error testing microphone:", error);
    updateStatus("Mic test failed", "red");
    return { detected: false, error: error.message };
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
    hideWindow: isMac ? () => window.electronAPI.hideWindow() : null,
    focusRestoreDelayMs: isMac ? 180 : 60,
    requestMicrophoneAccess: () => window.electronAPI.requestMicrophoneAccess(),
    transcribeAudio: (arrayBuffer) => window.electronAPI.transcribeAudio(arrayBuffer),
    transcribeAudioChunked: (arrayBuffers) => window.electronAPI.transcribeAudioChunked(arrayBuffers),
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
