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
  sendDiagnostics: (payload) => ipcRenderer.send("renderer-diagnostics", payload),
});
