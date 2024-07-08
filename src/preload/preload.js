const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onTestMessage: (callback) =>
    ipcRenderer.on("test-message", (_, message) => callback(message)),
  onToggleRecording: (callback) => {
    console.log("Setting up onToggleRecording in preload");
    ipcRenderer.on("toggle-recording", (event) => {
      console.log("toggle-recording event received in preload", event);
      callback();
    });
  },
  transcribeAudio: (arrayBuffer) => {
    console.log("ArrayBuffer size in preload:", arrayBuffer.byteLength);
    return ipcRenderer.invoke("transcribe-audio", arrayBuffer);
  },
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  simulateTyping: (text) => ipcRenderer.invoke("simulate-typing", text),
  requestMicrophoneAccess: () =>
    ipcRenderer.invoke("request-microphone-access"),
  onTranscriptionResult: (callback) =>
    ipcRenderer.on("transcription-result", (_, result) => callback(result)),
});

console.log("Preload script executed");
