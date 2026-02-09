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
  const ok = globalShortcut.register(config.shortcut, () => {
    windowManager.showWindow();
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((window) => window.webContents.send("toggle-recording"));
  });
  if (!ok) {
    logger.error(`Failed to register global shortcut: ${config.shortcut}`);
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
    logger.log("Renderer Console:", message);
  });
  return mainWindow;
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
  diagnostics.printStartup();
  logger.log(`Log file: ${logger.getCurrentLogPath()}`);
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
  return {
    shortcut: config.shortcut,
    model: config.transcription.model,
    fallbackModel: config.transcription.fallbackModel,
    timeoutMs: config.transcription.timeoutMs,
    maxQueue: config.transcription.maxQueue,
    recorderTimesliceMs: config.app.mediaRecorderTimesliceMs,
    clipboardRestoreMode: config.app.clipboardRestoreMode,
  };
});

ipcMain.on("renderer-diagnostics", (_event, payload) => {
  diagnostics.logRendererPayload(payload);
});
