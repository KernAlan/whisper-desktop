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
const { ConsoleService } = require("./services/console-service");

require("dotenv").config();

const config = loadConfig();
const recoveryDir = path.join(app.getPath("userData"), "recovery");
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
  recoveryDir,
});
const typingService = new TypingService({
  logger,
  restoreMode: config.app.clipboardRestoreMode,
  restoreDelayMs: config.app.clipboardRestoreDelayMs,
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // New instance couldn't get the lock — the old instance will receive
  // 'second-instance' and quit. Wait for it, then retry.
  console.log("Waiting for previous instance to exit...");
  setTimeout(() => {
    const retry = app.requestSingleInstanceLock();
    if (!retry) {
      console.error("Could not take over from previous instance.");
      app.exit(1);
    }
    // Lock acquired — continue boot normally
  }, 1500);
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

function applySettings(payload) {
  if (!payload || typeof payload !== "object") return;

  if (typeof payload.shortcut === "string" && payload.shortcut.trim()) {
    runtimeSettings.shortcut = payload.shortcut.trim();
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
}

const consoleService = new ConsoleService({
  runtimeSettings,
  applySettings,
  setupShortcut,
  diagnostics,
  logger,
  mainWindow: null,
  app,
  transcriptionService,
});

function createAndWireMainWindow() {
  const mainWindow = windowManager.createMainWindow();
  consoleService.setMainWindow(mainWindow);
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
  consoleService.start();
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
  // New instance is taking over — quit so it can acquire the lock
  logger.log("New instance detected — yielding.");
  app.quit();
});

ipcMain.handle("transcribe-audio", async (_event, arrayBuffer) => {
  return transcriptionService.transcribe(arrayBuffer);
});

ipcMain.handle("transcribe-audio-chunked", async (_event, arrayBuffers) => {
  return transcriptionService.transcribeChunked(arrayBuffers);
});

ipcMain.handle("simulate-typing", async (_event, text) => {
  if (process.platform === "darwin") {
    try {
      const trusted = systemPreferences.isTrustedAccessibilityClient(true);
      if (!trusted) {
        logger.warn("Accessibility permission is not granted; cannot simulate Cmd+V.");
        return {
          ok: false,
          error: "accessibility-not-trusted",
        };
      }
    } catch (error) {
      logger.error("Failed to check accessibility permission:", error);
    }
  }

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
  applySettings(payload);
  if (typeof payload?.shortcut === "string" && payload.shortcut.trim()) {
    setupShortcut();
  }
  return getRuntimeConfigPayload();
});

ipcMain.on("renderer-diagnostics", (_event, payload) => {
  diagnostics.logRendererPayload(payload);
});

ipcMain.on("refresh-mic-result", (_event, data) => {
  consoleService.handleIpcResult("refresh-mic-result", data);
});

ipcMain.on("test-mic-result", (_event, data) => {
  consoleService.handleIpcResult("test-mic-result", data);
});

ipcMain.on("list-devices-result", (_event, data) => {
  consoleService.handleIpcResult("list-devices-result", data);
});
