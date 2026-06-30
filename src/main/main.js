const {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  globalShortcut,
  powerMonitor,
  systemPreferences,
} = require("electron");
const path = require("path");
const { loadConfig, validateConfig } = require("../shared/config");
const { WindowManager } = require("./ui/window-manager");
const { TranscriptionService } = require("./services/transcription-service");
const { TypingService } = require("./services/typing-service");
const { DiagnosticsService } = require("./services/diagnostics-service");
const { TranscriptStore } = require("./services/transcript-store");
const { Logger } = require("./services/logger");
const { ConsoleService } = require("./services/console-service");
const { DictionaryService } = require("./services/dictionary-service");
const { TextProcessingService } = require("./services/text-processing-service");
const {
  RuntimeSettingsService,
  createRuntimeDefaults,
  applyRuntimeSettings,
} = require("./services/runtime-settings-service");

require("dotenv").config();

const config = loadConfig();
const recoveryDir = path.join(app.getPath("userData"), "recovery");
const transcriptDir = path.join(app.getPath("userData"), "transcripts");
const dictionaryPath = path.join(app.getPath("userData"), "dictionary.json");
const configIssues = validateConfig(config);
const logger = new Logger({
  logFilePath: process.env.APP_LOG_FILE || path.join(process.cwd(), "logs", "app.log"),
});
const runtimeDefaults = createRuntimeDefaults(config);
const runtimeSettingsService = new RuntimeSettingsService({
  filePath: path.join(app.getPath("userData"), "settings.json"),
  defaults: runtimeDefaults,
  logger,
});
const runtimeSettings = runtimeSettingsService.loadSync();
const COMMAND_SHORTCUT_FALLBACKS = [
  "CommandOrControl+Alt+E",
  "CommandOrControl+Shift+J",
];
const shortcutRegistration = {
  shortcutOk: false,
  commandShortcutOk: false,
  registeredShortcut: "",
  registeredCommandShortcut: "",
};
const HOTKEY_DOUBLE_TAP_MS = 450;
let lastDictationHotkeyAt = 0;
const transcriptStore = new TranscriptStore({ dir: transcriptDir, logger });
const diagnostics = new DiagnosticsService(config, logger, { transcriptStore });
const windowManager = new WindowManager({ hideWindowMs: config.app.hideWindowMs });
const dictionaryService = new DictionaryService({ filePath: dictionaryPath, logger });
const transcriptionService = new TranscriptionService({
  apiKey: config.transcription.apiKey,
  model: runtimeSettings.model,
  fallbackModel: runtimeSettings.fallbackModel,
  timeoutMs: runtimeSettings.timeoutMs,
  maxQueue: runtimeSettings.maxQueue,
  dictionaryService,
  logger,
  onMetric: (metric) => diagnostics.logTranscriptionMetric(metric),
  recoveryDir,
});
const typingService = new TypingService({
  logger,
  restoreMode: runtimeSettings.clipboardRestoreMode,
  restoreDelayMs: runtimeSettings.clipboardRestoreDelayMs,
  pasteChunkChars: runtimeSettings.pasteChunkChars,
  pasteChunkDelayMs: runtimeSettings.pasteChunkDelayMs,
});
const textProcessingService = new TextProcessingService({
  apiKey: config.text.apiKey,
  model: runtimeSettings.textModel,
  timeoutMs: config.text.timeoutMs,
  polishChunkWords: runtimeSettings.polishChunkWords,
  polishMaxWords: runtimeSettings.polishMaxWords,
  dictionaryService,
  logger,
});

function isShortcutDisabled(shortcut) {
  return !shortcut || String(shortcut).trim().toLowerCase() === "off";
}

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
  lastDictationHotkeyAt = 0;
  shortcutRegistration.shortcutOk = false;
  shortcutRegistration.commandShortcutOk = false;
  shortcutRegistration.registeredShortcut = "";
  shortcutRegistration.registeredCommandShortcut = "";

  const dictationHandler = () => {
    const now = Date.now();
    const showRecovery = now - lastDictationHotkeyAt <= HOTKEY_DOUBLE_TAP_MS;
    lastDictationHotkeyAt = now;
    windowManager.showWindow({ autoHide: false });
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((window) =>
      window.webContents.send("toggle-recording", {
        mode: "dictation",
        dictationMode: runtimeSettings.dictationMode,
        showRecovery,
      })
    );
  };

  const dictationOk = globalShortcut.register(runtimeSettings.shortcut, dictationHandler);
  if (dictationOk) {
    shortcutRegistration.shortcutOk = true;
    shortcutRegistration.registeredShortcut = runtimeSettings.shortcut;
  } else {
    logger.error(`Failed to register global shortcut: ${runtimeSettings.shortcut}`);
  }

  if (isShortcutDisabled(runtimeSettings.commandShortcut)) {
    shortcutRegistration.commandShortcutOk = true;
  } else {
    const commandHandler = async () => {
      const selection = await typingService.captureSelectedText();
      windowManager.showWindow({ autoHide: false });
      const windows = BrowserWindow.getAllWindows();
      windows.forEach((window) =>
        window.webContents.send("toggle-recording", {
          mode: "command",
          selectedText: selection.text,
          selection,
        })
      );
    };

    const commandCandidates = [
      runtimeSettings.commandShortcut,
      ...COMMAND_SHORTCUT_FALLBACKS,
    ].filter((value, index, all) => value && all.indexOf(value) === index);
    for (const shortcut of commandCandidates) {
      if (globalShortcut.register(shortcut, commandHandler)) {
        shortcutRegistration.commandShortcutOk = true;
        shortcutRegistration.registeredCommandShortcut = shortcut;
        if (shortcut !== runtimeSettings.commandShortcut) {
          logger.warn(
            `Command shortcut unavailable: ${runtimeSettings.commandShortcut}. Using ${shortcut} for this session.`
          );
        }
        break;
      }
    }

    if (!shortcutRegistration.commandShortcutOk) {
      logger.error(
        `Failed to register command shortcut: ${runtimeSettings.commandShortcut}. Tried: ${commandCandidates.join(", ")}`
      );
    }
  }

  return { ...shortcutRegistration };
}

function recoverAfterResume(reason = "resume") {
  logger.log(`[Power] ${reason}; refreshing shortcuts and overlay state.`);
  try {
    setupShortcut();
    windowManager.recoverWindowState();
    broadcastRuntimeConfig();
    const window = windowManager.getWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send("app-resume", { reason });
    }
  } catch (error) {
    logger.error(`[Power] resume recovery failed: ${error?.message || error}`);
  }
}

function syncRuntimeServices() {
  transcriptionService.setModels({
    model: runtimeSettings.model,
    fallbackModel: runtimeSettings.fallbackModel,
  });
  textProcessingService.setModel(runtimeSettings.textModel);
  typingService.setRestoreConfig({
    restoreMode: runtimeSettings.clipboardRestoreMode,
    restoreDelayMs: runtimeSettings.clipboardRestoreDelayMs,
  });
  typingService.setPasteConfig({
    pasteChunkChars: runtimeSettings.pasteChunkChars,
    pasteChunkDelayMs: runtimeSettings.pasteChunkDelayMs,
  });
  textProcessingService.setPolishConfig({
    polishChunkWords: runtimeSettings.polishChunkWords,
    polishMaxWords: runtimeSettings.polishMaxWords,
  });
}

function applySettings(payload, { persist = true } = {}) {
  if (!payload || typeof payload !== "object") return;

  Object.assign(runtimeSettings, applyRuntimeSettings(runtimeSettings, payload));
  syncRuntimeServices();
  if (persist) runtimeSettingsService.saveSync(runtimeSettings);
}

function resetSettings() {
  Object.keys(runtimeSettings).forEach((key) => delete runtimeSettings[key]);
  Object.assign(runtimeSettings, runtimeSettingsService.resetSync());
  syncRuntimeServices();
}

const consoleService = new ConsoleService({
  runtimeSettings,
  applySettings: (payload) => {
    applySettings(payload);
    broadcastRuntimeConfig();
  },
  resetSettings: () => {
    resetSettings();
    setupShortcut();
    return broadcastRuntimeConfig();
  },
  setupShortcut,
  diagnostics,
  logger,
  mainWindow: null,
  app,
  transcriptionService,
  transcriptStore,
  dictionaryService,
  openSettings: () => windowManager.showSettingsWindow(),
});

function createAndWireMainWindow() {
  const mainWindow = windowManager.createMainWindow();
  consoleService.setMainWindow(mainWindow);
  windowManager.createMenu({
    onShowApp: () => windowManager.showWindow(),
    onSettings: () => windowManager.showSettingsWindow(),
    onQuit: () => app.quit(),
  });
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
    shortcutOk: shortcutRegistration.shortcutOk,
    commandShortcutOk: shortcutRegistration.commandShortcutOk,
    registeredShortcut: shortcutRegistration.registeredShortcut,
    registeredCommandShortcut: shortcutRegistration.registeredCommandShortcut,
    model: runtimeSettings.model,
    fallbackModel: runtimeSettings.fallbackModel,
    textModel: runtimeSettings.textModel,
    polishChunkWords: runtimeSettings.polishChunkWords,
    polishMaxWords: runtimeSettings.polishMaxWords,
    timeoutMs: runtimeSettings.timeoutMs,
    maxQueue: runtimeSettings.maxQueue,
    recorderTimesliceMs: runtimeSettings.recorderTimesliceMs,
    previewIntervalMs: runtimeSettings.previewIntervalMs,
    dictationMode: runtimeSettings.dictationMode,
    doneHideWindowMs: runtimeSettings.doneHideWindowMs,
    clipboardRestoreMode: runtimeSettings.clipboardRestoreMode,
    clipboardRestoreDelayMs: runtimeSettings.clipboardRestoreDelayMs,
    pasteChunkChars: runtimeSettings.pasteChunkChars,
    pasteChunkDelayMs: runtimeSettings.pasteChunkDelayMs,
    dictionaryTerms: dictionaryService.list(),
    apiKeyOk: Boolean(config.transcription.apiKey),
    configIssues,
  };
}

function broadcastRuntimeConfig() {
  const nextConfig = getRuntimeConfigPayload();
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send("runtime-config-updated", nextConfig);
  });
  return nextConfig;
}

function transcriptionErrorPayload(error, recoveryFiles = []) {
  return {
    ok: false,
    error: error?.message || "Transcription failed",
    recoveryFiles: Array.isArray(error?.recoveryFiles) && error.recoveryFiles.length
      ? error.recoveryFiles
      : recoveryFiles,
    partialText: typeof error?.partialText === "string" ? error.partialText : "",
  };
}

async function saveRecoveryForFailedBuffer(arrayBuffer, error) {
  if (Array.isArray(error?.recoveryFiles) && error.recoveryFiles.length) return [];
  try {
    const recovery = await transcriptionService.saveAudioBufferToRecovery(arrayBuffer);
    return recovery ? [recovery] : [];
  } catch (recoveryError) {
    logger.error("[Recovery] Failed to save failed transcription buffer:", recoveryError);
    return [];
  }
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
  powerMonitor.on("resume", () => {
    setTimeout(() => recoverAfterResume("resume"), 1000);
  });
  powerMonitor.on("unlock-screen", () => {
    setTimeout(() => recoverAfterResume("unlock-screen"), 500);
  });
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
  try {
    return {
      ok: true,
      text: await transcriptionService.transcribe(arrayBuffer),
    };
  } catch (error) {
    const recoveryFiles = await saveRecoveryForFailedBuffer(arrayBuffer, error);
    return transcriptionErrorPayload(error, recoveryFiles);
  }
});

ipcMain.handle("transcribe-preview", async (_event, arrayBuffer) => {
  return transcriptionService.transcribePreview(arrayBuffer);
});

ipcMain.handle("transcribe-audio-chunked", async (_event, arrayBuffers) => {
  try {
    return {
      ok: true,
      text: await transcriptionService.transcribeChunked(arrayBuffers),
    };
  } catch (error) {
    return transcriptionErrorPayload(error);
  }
});

ipcMain.handle("retry-recovery", async (_event, payload) => {
  const target = payload && typeof payload === "object" ? payload.target : payload;
  const removeOnSuccess = payload && typeof payload === "object"
    ? payload.removeOnSuccess !== false
    : true;
  try {
    return {
      ok: true,
      text: await transcriptionService.retryRecoveryFile(String(target || "latest"), {
        removeOnSuccess,
      }),
    };
  } catch (error) {
    return transcriptionErrorPayload(error);
  }
});

ipcMain.handle("delete-recovery", async (_event, target) => {
  return {
    ok: true,
    deleted: await transcriptionService.deleteRecoveryTarget(String(target || "latest")),
  };
});

ipcMain.handle("copy-text", async (_event, text) => {
  clipboard.writeText(String(text || ""));
  return true;
});

ipcMain.handle("list-transcripts", async (_event, limit) => {
  const entries = await transcriptStore.list(Number(limit) || 5);
  return Promise.all(entries.map(async (entry) => {
    const text = require("fs").readFileSync(entry.path, "utf8");
    return {
      name: entry.name,
      text,
      chars: text.length,
      modified: entry.modified,
    };
  }));
});

ipcMain.handle("copy-latest-transcript", async () => {
  const entry = await transcriptStore.latest();
  if (!entry?.text?.trim()) return { ok: false, error: "No saved transcripts" };
  clipboard.writeText(entry.text);
  return { ok: true, chars: entry.text.length };
});

ipcMain.handle("simulate-typing", async (event, text) => {
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

  return typingService.pasteText(text, {
    onProgress: (progress) => event.sender.send("typing-progress", progress),
  });
});

ipcMain.handle("capture-selected-text", async () => {
  return typingService.captureSelectedText();
});

ipcMain.handle("process-command", async (_event, payload) => {
  return textProcessingService.applyCommand(payload || {});
});

ipcMain.handle("polish-dictation", async (_event, payload) => {
  return textProcessingService.polishDictation(payload || {});
});

ipcMain.handle("request-microphone-access", async () => {
  const hasAccess = await checkAndRequestMicrophonePermission();
  if (!hasAccess) throw new Error("Microphone access not granted");
  return true;
});

ipcMain.handle("hide-window", () => {
  windowManager.hideWindow();
});

ipcMain.handle("show-window", () => {
  windowManager.showWindow({ autoHide: false });
});

ipcMain.handle("open-settings", () => {
  windowManager.showSettingsWindow();
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
  return broadcastRuntimeConfig();
});

ipcMain.handle("reset-runtime-settings", async () => {
  resetSettings();
  setupShortcut();
  return broadcastRuntimeConfig();
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

ipcMain.handle("dictionary-suggest", async () => {
  return diagnostics.suggestDictionaryTerms(dictionaryService.list());
});

ipcMain.on("renderer-diagnostics", (_event, payload) => {
  if (
    payload?.type === "mic-init-error" ||
    payload?.type === "paste-failed" ||
    payload?.type === "recovery-saved" ||
    payload?.type === "api-key-missing"
  ) {
    windowManager.showWindow({ autoHide: false });
  }
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
