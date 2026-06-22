const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onToggleRecording: (callback) => {
    ipcRenderer.on("toggle-recording", (_event, payload) => callback(payload));
  },
  transcribeAudio: (arrayBuffer) => ipcRenderer.invoke("transcribe-audio", arrayBuffer),
  transcribePreview: (arrayBuffer) => ipcRenderer.invoke("transcribe-preview", arrayBuffer),
  transcribeAudioChunked: (arrayBuffers) => ipcRenderer.invoke("transcribe-audio-chunked", arrayBuffers),
  retryRecovery: (target, options = {}) => ipcRenderer.invoke("retry-recovery", { target, ...options }),
  deleteRecovery: (target) => ipcRenderer.invoke("delete-recovery", target),
  copyText: (text) => ipcRenderer.invoke("copy-text", text),
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  scheduleHideWindow: (delayMs) => ipcRenderer.invoke("schedule-hide-window", delayMs),
  cancelHideWindow: () => ipcRenderer.invoke("cancel-hide-window"),
  simulateTyping: (text) => ipcRenderer.invoke("simulate-typing", text),
  captureSelectedText: () => ipcRenderer.invoke("capture-selected-text"),
  processCommand: (payload) => ipcRenderer.invoke("process-command", payload),
  polishDictation: (payload) => ipcRenderer.invoke("polish-dictation", payload),
  requestMicrophoneAccess: () =>
    ipcRenderer.invoke("request-microphone-access"),
  getRuntimeConfig: () => ipcRenderer.invoke("get-runtime-config"),
  updateRuntimeSettings: (settings) => ipcRenderer.invoke("update-runtime-settings", settings),
  resetRuntimeSettings: () => ipcRenderer.invoke("reset-runtime-settings"),
  onRuntimeConfigUpdated: (callback) => {
    ipcRenderer.on("runtime-config-updated", (_event, payload) => callback(payload));
  },
  listDictionary: () => ipcRenderer.invoke("dictionary-list"),
  addDictionaryTerm: (term) => ipcRenderer.invoke("dictionary-add", term),
  removeDictionaryTerm: (term) => ipcRenderer.invoke("dictionary-remove", term),
  suggestDictionaryTerms: () => ipcRenderer.invoke("dictionary-suggest"),
  sendDiagnostics: (payload) => ipcRenderer.send("renderer-diagnostics", payload),
  onTypingProgress: (callback) => {
    ipcRenderer.on("typing-progress", (_event, payload) => callback(payload));
  },
  onRefreshMic: (callback) => {
    ipcRenderer.on("refresh-mic", () => callback());
  },
  onTestMic: (callback) => {
    ipcRenderer.on("test-mic", () => callback());
  },
  onListDevices: (callback) => {
    ipcRenderer.on("list-devices", () => callback());
  },
  sendRefreshMicResult: (data) => ipcRenderer.send("refresh-mic-result", data),
  sendTestMicResult: (data) => ipcRenderer.send("test-mic-result", data),
  sendListDevicesResult: (data) => ipcRenderer.send("list-devices-result", data),
  onRetryPaste: (callback) => {
    ipcRenderer.on("retry-paste", (_event, text) => callback(text));
  },
});
