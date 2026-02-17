const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onToggleRecording: (callback) => {
    ipcRenderer.on("toggle-recording", () => callback());
  },
  transcribeAudio: (arrayBuffer) => ipcRenderer.invoke("transcribe-audio", arrayBuffer),
  transcribeAudioChunked: (arrayBuffers) => ipcRenderer.invoke("transcribe-audio-chunked", arrayBuffers),
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  simulateTyping: (text) => ipcRenderer.invoke("simulate-typing", text),
  requestMicrophoneAccess: () =>
    ipcRenderer.invoke("request-microphone-access"),
  getRuntimeConfig: () => ipcRenderer.invoke("get-runtime-config"),
  updateRuntimeSettings: (settings) => ipcRenderer.invoke("update-runtime-settings", settings),
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
