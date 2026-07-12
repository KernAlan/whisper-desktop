const {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  globalShortcut,
  powerMonitor,
  safeStorage,
  systemPreferences,
} = require("electron");
const path = require("path");
const { randomUUID } = require("node:crypto");
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
const { CredentialService } = require("./services/credential-service");
const { TargetContextService } = require("./services/target-context-service");
const { WakeWordService } = require("./services/wake-word-service");
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
let lastInsertion = null;
const UNDO_WINDOW_MS = 60 * 1000;
const transcriptStore = new TranscriptStore({ dir: transcriptDir, logger });
const diagnostics = new DiagnosticsService(config, logger, { transcriptStore });
const windowManager = new WindowManager({ hideWindowMs: config.app.hideWindowMs });
const dictionaryService = new DictionaryService({ filePath: dictionaryPath, logger });
const credentialService = new CredentialService({
  filePath: path.join(app.getPath("userData"), "credentials.json"),
  safeStorage,
  logger,
});
const targetContextService = new TargetContextService({ logger });
const wakeModelDir = app.isPackaged
  ? path.join(process.resourcesPath, "wake")
  : path.join(__dirname, "assets", "wake");

async function handleWakeWordDetected(payload) {
  if (payload?.mode === "close") {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send("wake-word-detected", {
        keyword: payload?.keyword || "Stop Whisper",
        mode: "close",
      });
    });
    return;
  }

  const targetCaptureId = randomUUID();
  const targetContextPromise = targetContextService.capture();
  windowManager.showWindow({ autoHide: false });
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send("wake-word-detected", {
      keyword: payload?.keyword || "Hey Whisper",
      mode: "wake",
      targetCaptureId,
    });
  });

  try {
    const targetContext = await targetContextPromise;
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send("target-context-captured", { targetCaptureId, targetContext });
    });
  } catch (error) {
    logger.warn(`[Wake] Target capture failed: ${error?.message || error}`);
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send("target-context-captured", {
        targetCaptureId,
        targetContext: null,
      });
    });
  }
}

const wakeWordService = new WakeWordService({
  modelDir: wakeModelDir,
  logger,
  onDetected: (payload) => {
    handleWakeWordDetected(payload).catch((error) => {
      logger.error(`[Wake] Activation failed: ${error?.message || error}`);
    });
  },
});
let activeApiKey = config.transcription.apiKey;
let apiKeySource = activeApiKey ? "environment" : "missing";
const transcriptionService = new TranscriptionService({
  apiKey: activeApiKey,
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
  targetContextService,
});
const textProcessingService = new TextProcessingService({
  apiKey: activeApiKey,
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
const singleInstanceLockReady = hasSingleInstanceLock
  ? Promise.resolve(true)
  : new Promise((resolve) => {
      // The existing instance exits on second-instance. Do not create a window
      // or register shortcuts until this process actually owns the lock.
      console.log("Waiting for previous instance to exit...");
      const deadline = Date.now() + 5000;
      const retry = () => {
        if (app.requestSingleInstanceLock()) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          console.error("Could not take over from previous instance.");
          resolve(false);
          return;
        }
        setTimeout(retry, 250);
      };
      setTimeout(retry, 500);
    });

function setupShortcut() {
  globalShortcut.unregisterAll();
  lastDictationHotkeyAt = 0;
  shortcutRegistration.shortcutOk = false;
  shortcutRegistration.commandShortcutOk = false;
  shortcutRegistration.registeredShortcut = "";
  shortcutRegistration.registeredCommandShortcut = "";

  const dictationHandler = async () => {
    const now = Date.now();
    const showRecovery = now - lastDictationHotkeyAt <= HOTKEY_DOUBLE_TAP_MS;
    lastDictationHotkeyAt = now;
    const targetCaptureId = showRecovery ? "" : randomUUID();
    const targetCapturePromise = showRecovery
      ? Promise.resolve(null)
      : targetContextService.capture();
    windowManager.showWindow({ autoHide: false });
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((window) =>
      window.webContents.send("toggle-recording", {
        mode: "dictation",
        dictationMode: runtimeSettings.dictationMode,
        showRecovery,
        targetContext: null,
        targetCaptureId,
      })
    );

    if (!showRecovery) {
      targetCapturePromise
        .then((targetContext) => {
          BrowserWindow.getAllWindows().forEach((window) => {
            window.webContents.send("target-context-captured", {
              targetCaptureId,
              targetContext,
            });
          });
        })
        .catch((error) => {
          logger.warn(`[Target] Async capture failed: ${error?.message || error}`);
          BrowserWindow.getAllWindows().forEach((window) => {
            window.webContents.send("target-context-captured", {
              targetCaptureId,
              targetContext: null,
            });
          });
        });
    }
  };

  const dictationOk = globalShortcut.register(runtimeSettings.shortcut, dictationHandler);
  if (dictationOk) {
    shortcutRegistration.shortcutOk = true;
    shortcutRegistration.registeredShortcut = runtimeSettings.shortcut;
    logger.log(`[Shortcut] Dictation registered: ${runtimeSettings.shortcut}`);
  } else {
    logger.error(`Failed to register global shortcut: ${runtimeSettings.shortcut}`);
  }

  if (isShortcutDisabled(runtimeSettings.commandShortcut)) {
    shortcutRegistration.commandShortcutOk = true;
  } else {
    const commandHandler = async () => {
      const targetContext = await targetContextService.capture();
      const selection = await typingService.captureSelectedText({ targetContext });
      windowManager.showWindow({ autoHide: false });
      const windows = BrowserWindow.getAllWindows();
      windows.forEach((window) =>
        window.webContents.send("toggle-recording", {
          mode: "command",
          selectedText: selection.text,
          selection,
          targetContext,
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
  transcriptionService.setTimeoutMs(runtimeSettings.timeoutMs);
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

function setActiveApiKey(apiKey, source) {
  activeApiKey = String(apiKey || "").trim();
  apiKeySource = activeApiKey ? source : "missing";
  transcriptionService.setApiKey(activeApiKey);
  textProcessingService.setApiKey(activeApiKey);
  diagnostics.setApiKeyConfigured(activeApiKey);
}

function getCurrentConfigIssues() {
  return validateConfig({
    ...config,
    transcription: { ...config.transcription, apiKey: activeApiKey },
    text: { ...config.text, apiKey: activeApiKey },
  });
}

function getCredentialStatus() {
  return {
    configured: Boolean(activeApiKey),
    source: apiKeySource,
    secureStorageAvailable: credentialService.isEncryptionAvailable(),
  };
}

function applySettings(payload, { persist = true } = {}) {
  if (!payload || typeof payload !== "object") return;

  Object.assign(runtimeSettings, applyRuntimeSettings(runtimeSettings, payload));
  syncRuntimeServices();
  if (!runtimeSettings.wakePhraseEnabled) wakeWordService.stop();
  if (persist) runtimeSettingsService.saveSync(runtimeSettings);
}

function resetSettings() {
  Object.keys(runtimeSettings).forEach((key) => delete runtimeSettings[key]);
  Object.assign(runtimeSettings, runtimeSettingsService.resetSync());
  syncRuntimeServices();
  if (!runtimeSettings.wakePhraseEnabled) wakeWordService.stop();
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
  wakeWordService,
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
    wakePhraseEnabled: runtimeSettings.wakePhraseEnabled,
    dictionaryTerms: dictionaryService.list(),
    apiKeyOk: Boolean(activeApiKey),
    credential: getCredentialStatus(),
    configIssues: getCurrentConfigIssues(),
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
  if (!(await singleInstanceLockReady)) {
    app.exit(1);
    return;
  }

  const savedApiKey = credentialService.loadApiKey();
  if (savedApiKey) setActiveApiKey(savedApiKey, "secure storage");
  diagnostics.printStartup({
    logFilePath: logger.getCurrentLogPath(),
    appVersion: app.getVersion(),
  });
  const currentConfigIssues = getCurrentConfigIssues();
  if (currentConfigIssues.length) {
    currentConfigIssues.forEach((issue) => logger.warn(`[Config] ${issue}`));
  }

  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true,
  });

  await dictionaryService.load();
  await transcriptionService.pruneRecovery();
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

ipcMain.handle("wake-word-start", (_event, options = {}) => {
  try {
    return wakeWordService.start(options);
  } catch (error) {
    logger.error(`[Wake] Could not start local detector: ${error?.message || error}`);
    return {
      ...wakeWordService.getStatus(),
      error: error?.message || "Local wake detector unavailable",
    };
  }
});

ipcMain.handle("wake-word-stop", () => wakeWordService.stop());
ipcMain.on("wake-word-frame", (_event, frame) => wakeWordService.processFrame(frame));

ipcMain.handle("transcribe-checkpoint", async (_event, { arrayBuffer, options } = {}) => {
  try {
    const result = await transcriptionService.transcribeCheckpoint(arrayBuffer, options);
    return { ok: true, text: result.text, recovery: result.recovery };
  } catch (error) {
    return transcriptionErrorPayload(error);
  }
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
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    text: entry.text,
    rawText: entry.rawText,
    chars: entry.text.length,
    modified: entry.modified,
    mode: entry.mode,
    target: entry.target,
    paste: entry.paste,
    undone: entry.undone,
  }));
});

ipcMain.handle("copy-latest-transcript", async () => {
  const entry = await transcriptStore.latest();
  if (!entry?.text?.trim()) return { ok: false, error: "No saved transcripts" };
  clipboard.writeText(entry.text);
  return { ok: true, chars: entry.text.length };
});

ipcMain.handle("simulate-typing", async (event, payload) => {
  const text = payload && typeof payload === "object" ? payload.text : payload;
  const targetContext = payload && typeof payload === "object" ? payload.targetContext : undefined;
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

  const result = await typingService.pasteText(text, {
    targetContext,
    onProgress: (progress) => event.sender.send("typing-progress", progress),
  });
  if (result?.ok && targetContext?.available) {
    const transactionId = randomUUID();
    lastInsertion = {
      id: transactionId,
      targetContext,
      createdAt: Date.now(),
      undone: false,
    };
    return { ...result, transactionId };
  }
  return result;
});

ipcMain.handle("undo-last-insertion", async () => {
  if (!lastInsertion || lastInsertion.undone) {
    return { ok: false, error: "No recent insertion is available to undo." };
  }
  if (Date.now() - lastInsertion.createdAt > UNDO_WINDOW_MS) {
    return { ok: false, error: "The undo window has expired." };
  }
  if (process.platform === "darwin") {
    try {
      if (!systemPreferences.isTrustedAccessibilityClient(true)) {
        return { ok: false, error: "accessibility-not-trusted" };
      }
    } catch (error) {
      logger.error("Failed to check accessibility permission for undo:", error);
    }
  }
  try {
    await targetContextService.sendUndo(lastInsertion.targetContext);
    lastInsertion.undone = true;
    await transcriptStore.markUndone(lastInsertion.id);
    return { ok: true, transactionId: lastInsertion.id };
  } catch (error) {
    return { ok: false, error: error?.message || "Undo failed" };
  }
});

ipcMain.handle("capture-selected-text", async (_event, targetContext) => {
  return typingService.captureSelectedText({ targetContext });
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

ipcMain.handle("save-api-key", async (_event, apiKey) => {
  const savedApiKey = credentialService.saveApiKey(apiKey);
  setActiveApiKey(savedApiKey, "secure storage");
  logger.log("[Credentials] Groq API key saved to secure storage.");
  broadcastRuntimeConfig();
  return getCredentialStatus();
});

ipcMain.handle("clear-api-key", async () => {
  credentialService.clearApiKey();
  setActiveApiKey(config.transcription.apiKey, config.transcription.apiKey ? "environment" : "missing");
  logger.log("[Credentials] Saved Groq API key cleared.");
  broadcastRuntimeConfig();
  return getCredentialStatus();
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
