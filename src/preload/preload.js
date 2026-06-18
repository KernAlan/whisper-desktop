const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onToggleRecording: (callback) => {
    ipcRenderer.on("toggle-recording", (_event, payload) => callback(payload));
  },
  transcribeAudio: (arrayBuffer) => ipcRenderer.invoke("transcribe-audio", arrayBuffer),
  transcribePreview: (arrayBuffer) => ipcRenderer.invoke("transcribe-preview", arrayBuffer),
  transcribeAudioChunked: (arrayBuffers) => ipcRenderer.invoke("transcribe-audio-chunked", arrayBuffers),
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  scheduleHideWindow: (delayMs) => ipcRenderer.invoke("schedule-hide-window", delayMs),
  cancelHideWindow: () => ipcRenderer.invoke("cancel-hide-window"),
  simulateTyping: (text) => ipcRenderer.invoke("simulate-typing", text),
  captureSelectedText: () => ipcRenderer.invoke("capture-selected-text"),
  processCommand: (payload) => ipcRenderer.invoke("process-command", payload),
  requestMicrophoneAccess: () =>
    ipcRenderer.invoke("request-microphone-access"),
  getRuntimeConfig: () => ipcRenderer.invoke("get-runtime-config"),
  updateRuntimeSettings: (settings) => ipcRenderer.invoke("update-runtime-settings", settings),
  listDictionary: () => ipcRenderer.invoke("dictionary-list"),
  addDictionaryTerm: (term) => ipcRenderer.invoke("dictionary-add", term),
  removeDictionaryTerm: (term) => ipcRenderer.invoke("dictionary-remove", term),
  sendDiagnostics: (payload) => ipcRenderer.send("renderer-diagnostics", payload),
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
