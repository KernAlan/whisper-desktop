const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onToggleRecording: (callback) => {
    ipcRenderer.on("toggle-recording", () => callback());
  },
  transcribeAudio: (arrayBuffer) => ipcRenderer.invoke("transcribe-audio", arrayBuffer),
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  simulateTyping: (text) => ipcRenderer.invoke("simulate-typing", text),
  requestMicrophoneAccess: () =>
    ipcRenderer.invoke("request-microphone-access"),
  getRuntimeConfig: () => ipcRenderer.invoke("get-runtime-config"),
  updateRuntimeSettings: (settings) => ipcRenderer.invoke("update-runtime-settings", settings),
  sendDiagnostics: (payload) => ipcRenderer.send("renderer-diagnostics", payload),
});
