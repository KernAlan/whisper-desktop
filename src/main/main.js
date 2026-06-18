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
const { DictionaryService } = require("./services/dictionary-service");
const { TextProcessingService } = require("./services/text-processing-service");

require("dotenv").config();

const config = loadConfig();
const recoveryDir = path.join(app.getPath("userData"), "recovery");
const dictionaryPath = path.join(app.getPath("userData"), "dictionary.json");
const runtimeSettings = {
  shortcut: config.shortcut,
  commandShortcut: config.commandShortcut,
  model: config.transcription.model,
  fallbackModel: config.transcription.fallbackModel,
  textModel: config.text.model,
  timeoutMs: config.transcription.timeoutMs,
  maxQueue: config.transcription.maxQueue,
  recorderTimesliceMs: config.app.mediaRecorderTimesliceMs,
  previewIntervalMs: config.app.previewIntervalMs,
  doneHideWindowMs: config.app.doneHideWindowMs,
  clipboardRestoreMode: config.app.clipboardRestoreMode,
  clipboardRestoreDelayMs: config.app.clipboardRestoreDelayMs,
};
const configIssues = validateConfig(config);
const logger = new Logger({
  logFilePath: process.env.APP_LOG_FILE || path.join(process.cwd(), "logs", "app.log"),
});
const diagnostics = new DiagnosticsService(config, logger);
const windowManager = new WindowManager({ hideWindowMs: config.app.hideWindowMs });
const dictionaryService = new DictionaryService({ filePath: dictionaryPath, logger });
const transcriptionService = new TranscriptionService({
  apiKey: config.transcription.apiKey,
  model: config.transcription.model,
  fallbackModel: config.transcription.fallbackModel,
  timeoutMs: config.transcription.timeoutMs,
  maxQueue: config.transcription.maxQueue,
  dictionaryService,
  logger,
  onMetric: (metric) => diagnostics.logTranscriptionMetric(metric),
  recoveryDir,
});
const typingService = new TypingService({
  logger,
  restoreMode: config.app.clipboardRestoreMode,
  restoreDelayMs: config.app.clipboardRestoreDelayMs,
});
const textProcessingService = new TextProcessingService({
  apiKey: config.text.apiKey,
  model: config.text.model,
  timeoutMs: config.text.timeoutMs,
  dictionaryService,
  logger,
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
  const dictationOk = globalShortcut.register(runtimeSettings.shortcut, () => {
    windowManager.showWindow({ autoHide: false });
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((window) => window.webContents.send("toggle-recording", { mode: "dictation" }));
  });
  if (!dictationOk) {
    logger.error(`Failed to register global shortcut: ${runtimeSettings.shortcut}`);
  }

  const commandOk = globalShortcut.register(runtimeSettings.commandShortcut, async () => {
    const selectedText = await typingService.captureSelectedText();
    windowManager.showWindow({ autoHide: false });
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((window) =>
      window.webContents.send("toggle-recording", { mode: "command", selectedText })
    );
  });
  if (!commandOk) {
    logger.error(`Failed to register command shortcut: ${runtimeSettings.commandShortcut}`);
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

  if (typeof payload.textModel === "string" && payload.textModel.trim()) {
    runtimeSettings.textModel = payload.textModel.trim();
    textProcessingService.setModel(runtimeSettings.textModel);
  }

  if (typeof payload.commandShortcut === "string" && payload.commandShortcut.trim()) {
    runtimeSettings.commandShortcut = payload.commandShortcut.trim();
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

  if (Number.isFinite(payload.previewIntervalMs) && payload.previewIntervalMs >= 1000) {
    runtimeSettings.previewIntervalMs = Number(payload.previewIntervalMs);
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
  dictionaryService,
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
    commandShortcut: runtimeSettings.commandShortcut,
    model: runtimeSettings.model,
    fallbackModel: runtimeSettings.fallbackModel,
    textModel: runtimeSettings.textModel,
    timeoutMs: runtimeSettings.timeoutMs,
    maxQueue: runtimeSettings.maxQueue,
    recorderTimesliceMs: runtimeSettings.recorderTimesliceMs,
    previewIntervalMs: runtimeSettings.previewIntervalMs,
    doneHideWindowMs: runtimeSettings.doneHideWindowMs,
    clipboardRestoreMode: runtimeSettings.clipboardRestoreMode,
    clipboardRestoreDelayMs: runtimeSettings.clipboardRestoreDelayMs,
    dictionaryTerms: dictionaryService.list(),
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

app.on("ready", async () => {
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

  await dictionaryService.load();
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

ipcMain.handle("transcribe-preview", async (_event, arrayBuffer) => {
  return transcriptionService.transcribePreview(arrayBuffer);
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

ipcMain.handle("capture-selected-text", async () => {
  return typingService.captureSelectedText();
});

ipcMain.handle("process-command", async (_event, payload) => {
  return textProcessingService.applyCommand(payload || {});
});

ipcMain.handle("request-microphone-access", async () => {
  const hasAccess = await checkAndRequestMicrophonePermission();
  if (!hasAccess) throw new Error("Microphone access not granted");
  return true;
});

ipcMain.handle("hide-window", () => {
  windowManager.hideWindow();
});

ipcMain.handle("schedule-hide-window", (_event, delayMs) => {
  windowManager.scheduleHide(Number(delayMs) || undefined);
});

ipcMain.handle("cancel-hide-window", () => {
  windowManager.cancelHide();
});

ipcMain.handle("get-runtime-config", () => {
  return getRuntimeConfigPayload();
});

ipcMain.handle("update-runtime-settings", async (_event, payload) => {
  applySettings(payload);
  if (
    (typeof payload?.shortcut === "string" && payload.shortcut.trim()) ||
    (typeof payload?.commandShortcut === "string" && payload.commandShortcut.trim())
  ) {
    setupShortcut();
  }
  return getRuntimeConfigPayload();
});

ipcMain.handle("dictionary-list", async () => {
  return dictionaryService.list();
});

ipcMain.handle("dictionary-add", async (_event, term) => {
  return dictionaryService.add(term);
});

ipcMain.handle("dictionary-remove", async (_event, term) => {
  return dictionaryService.remove(term);
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
