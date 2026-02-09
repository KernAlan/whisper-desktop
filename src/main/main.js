const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  systemPreferences,
} = require("electron");
const path = require("path");
const { loadConfig, validateConfig } = require("../shared/config");
const { WindowManager } = require("./ui/window-manager");
const { TranscriptionService } = require("./services/transcription-service");
const { TypingService } = require("./services/typing-service");
const { DiagnosticsService } = require("./services/diagnostics-service");
const { Logger } = require("./services/logger");

require("dotenv").config();

const config = loadConfig();
const runtimeSettings = {
  shortcut: config.shortcut,
  model: config.transcription.model,
  fallbackModel: config.transcription.fallbackModel,
  timeoutMs: config.transcription.timeoutMs,
  maxQueue: config.transcription.maxQueue,
  recorderTimesliceMs: config.app.mediaRecorderTimesliceMs,
  clipboardRestoreMode: config.app.clipboardRestoreMode,
  clipboardRestoreDelayMs: config.app.clipboardRestoreDelayMs,
};
const configIssues = validateConfig(config);
const logger = new Logger({
  logFilePath: process.env.APP_LOG_FILE || path.join(process.cwd(), "logs", "app.log"),
});
const diagnostics = new DiagnosticsService(config, logger);
const windowManager = new WindowManager({ hideWindowMs: config.app.hideWindowMs });
const transcriptionService = new TranscriptionService({
  apiKey: config.transcription.apiKey,
  model: config.transcription.model,
  fallbackModel: config.transcription.fallbackModel,
  timeoutMs: config.transcription.timeoutMs,
  maxQueue: config.transcription.maxQueue,
  logger,
  onMetric: (metric) => diagnostics.logTranscriptionMetric(metric),
});
const typingService = new TypingService({
  logger,
  restoreMode: config.app.clipboardRestoreMode,
  restoreDelayMs: config.app.clipboardRestoreDelayMs,
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  logger.warn("Another Whisper Desktop instance is already running. Exiting.");
  app.quit();
}

function setupShortcut() {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(runtimeSettings.shortcut, () => {
    windowManager.showWindow();
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((window) => window.webContents.send("toggle-recording"));
  });
  if (!ok) {
    logger.error(`Failed to register global shortcut: ${runtimeSettings.shortcut}`);
  }
}

function createAndWireMainWindow() {
  const mainWindow = windowManager.createMainWindow();
  windowManager.createMenu(() => app.quit());
  mainWindow.webContents.on("did-finish-load", () => setupShortcut());
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    logger.error("Failed to load window:", code, description);
  });
  mainWindow.webContents.on("console-message", (_event, _level, message) => {
    if (typeof message !== "string") return;
    if (message.includes("DOM fully loaded and parsed")) return;
    if (message.includes("Renderer script loaded")) return;
    if (message.includes("electronAPI.onToggleRecording is available")) return;
    logger.log(`[UI] ${message}`);
  });
  return mainWindow;
}

function getRuntimeConfigPayload() {
  return {
    shortcut: runtimeSettings.shortcut,
    model: runtimeSettings.model,
    fallbackModel: runtimeSettings.fallbackModel,
    timeoutMs: runtimeSettings.timeoutMs,
    maxQueue: runtimeSettings.maxQueue,
    recorderTimesliceMs: runtimeSettings.recorderTimesliceMs,
    clipboardRestoreMode: runtimeSettings.clipboardRestoreMode,
    clipboardRestoreDelayMs: runtimeSettings.clipboardRestoreDelayMs,
  };
}

async function checkAndRequestMicrophonePermission() {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return true;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch (error) {
    logger.error("Error requesting microphone access:", error);
    return false;
  }
}

app.on("ready", () => {
  diagnostics.printStartup({
    logFilePath: logger.getCurrentLogPath(),
    appVersion: app.getVersion(),
  });
  if (configIssues.length) {
    configIssues.forEach((issue) => logger.warn(`[Config] ${issue}`));
  }

  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true,
  });

  createAndWireMainWindow();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createAndWireMainWindow();
  }
});

app.on("second-instance", () => {
  const mainWindow = windowManager.getWindow();
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

ipcMain.handle("transcribe-audio", async (_event, arrayBuffer) => {
  return transcriptionService.transcribe(arrayBuffer);
});

ipcMain.handle("simulate-typing", async (_event, text) => {
  return typingService.pasteText(text);
});

ipcMain.handle("request-microphone-access", async () => {
  const hasAccess = await checkAndRequestMicrophonePermission();
  if (!hasAccess) throw new Error("Microphone access not granted");
  return true;
});

ipcMain.handle("hide-window", () => {
  windowManager.hideWindow();
});

ipcMain.handle("get-runtime-config", () => {
  return getRuntimeConfigPayload();
});

ipcMain.handle("update-runtime-settings", async (_event, payload) => {
  if (!payload || typeof payload !== "object") {
    return getRuntimeConfigPayload();
  }

  if (typeof payload.shortcut === "string" && payload.shortcut.trim()) {
    runtimeSettings.shortcut = payload.shortcut.trim();
    setupShortcut();
  }

  if (typeof payload.model === "string" && payload.model.trim()) {
    runtimeSettings.model = payload.model.trim();
    transcriptionService.setModels({
      model: runtimeSettings.model,
      fallbackModel: runtimeSettings.fallbackModel,
    });
  }

  if (
    typeof payload.clipboardRestoreMode === "string" &&
    ["deferred", "blocking", "off"].includes(payload.clipboardRestoreMode)
  ) {
    runtimeSettings.clipboardRestoreMode = payload.clipboardRestoreMode;
  }

  if (Number.isFinite(payload.clipboardRestoreDelayMs) && payload.clipboardRestoreDelayMs > 0) {
    runtimeSettings.clipboardRestoreDelayMs = Number(payload.clipboardRestoreDelayMs);
  }

  if (Number.isFinite(payload.recorderTimesliceMs) && payload.recorderTimesliceMs >= 50) {
    runtimeSettings.recorderTimesliceMs = Number(payload.recorderTimesliceMs);
  }

  typingService.setRestoreConfig({
    restoreMode: runtimeSettings.clipboardRestoreMode,
    restoreDelayMs: runtimeSettings.clipboardRestoreDelayMs,
  });

  return getRuntimeConfigPayload();
});

ipcMain.on("renderer-diagnostics", (_event, payload) => {
  diagnostics.logRendererPayload(payload);
});
