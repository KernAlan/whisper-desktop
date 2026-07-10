const fs = require("fs-extra");

const MUTABLE_KEYS = [
  "shortcut",
  "commandShortcut",
  "model",
  "fallbackModel",
  "textModel",
  "polishChunkWords",
  "polishMaxWords",
  "timeoutMs",
  "recorderTimesliceMs",
  "previewIntervalMs",
  "dictationMode",
  "doneHideWindowMs",
  "clipboardRestoreMode",
  "clipboardRestoreDelayMs",
  "pasteChunkChars",
  "pasteChunkDelayMs",
];
const SETTINGS_VERSION = 3;
const LEGACY_DEFAULT_TIMEOUT_MS = 10000;
const LEGACY_DEFAULT_PREVIEW_MS = 1500;
const LEGACY_DEFAULT_POLISH_MAX_WORDS = 2500;

function createRuntimeDefaults(config) {
  return {
    shortcut: config.shortcut,
    commandShortcut: config.commandShortcut,
    model: config.transcription.model,
    fallbackModel: config.transcription.fallbackModel,
    textModel: config.text.model,
    polishChunkWords: config.text.polishChunkWords,
    polishMaxWords: config.text.polishMaxWords,
    timeoutMs: config.transcription.timeoutMs,
    maxQueue: config.transcription.maxQueue,
    recorderTimesliceMs: config.app.mediaRecorderTimesliceMs,
    previewIntervalMs: config.app.previewIntervalMs,
    dictationMode: config.app.dictationMode,
    doneHideWindowMs: config.app.doneHideWindowMs,
    clipboardRestoreMode: config.app.clipboardRestoreMode,
    clipboardRestoreDelayMs: config.app.clipboardRestoreDelayMs,
    pasteChunkChars: config.app.pasteChunkChars,
    pasteChunkDelayMs: config.app.pasteChunkDelayMs,
  };
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function applyRuntimeSettings(current, payload = {}) {
  const next = { ...current };

  const shortcut = cleanString(payload.shortcut);
  if (shortcut) next.shortcut = shortcut;

  const commandShortcut = cleanString(payload.commandShortcut);
  if (commandShortcut || payload.commandShortcut === "") next.commandShortcut = commandShortcut || "off";

  const model = cleanString(payload.model);
  if (model) next.model = model;

  const fallbackModel = cleanString(payload.fallbackModel);
  if (fallbackModel) next.fallbackModel = fallbackModel;

  const textModel = cleanString(payload.textModel);
  if (textModel) next.textModel = textModel;

  const polishChunkWords = cleanNumber(payload.polishChunkWords);
  if (polishChunkWords !== null && polishChunkWords >= 100) {
    next.polishChunkWords = polishChunkWords;
  }

  const polishMaxWords = cleanNumber(payload.polishMaxWords);
  if (polishMaxWords !== null && polishMaxWords >= next.polishChunkWords) {
    next.polishMaxWords = polishMaxWords;
  }

  const timeoutMs = cleanNumber(payload.timeoutMs);
  if (timeoutMs !== null && timeoutMs >= 3000) {
    next.timeoutMs = timeoutMs;
  }

  const recorderTimesliceMs = cleanNumber(payload.recorderTimesliceMs);
  if (recorderTimesliceMs !== null && recorderTimesliceMs >= 50) {
    next.recorderTimesliceMs = recorderTimesliceMs;
  }

  const previewIntervalMs = cleanNumber(payload.previewIntervalMs);
  if (previewIntervalMs !== null && previewIntervalMs >= 1000) {
    next.previewIntervalMs = previewIntervalMs;
  }

  if (["fast", "polished"].includes(payload.dictationMode)) {
    next.dictationMode = payload.dictationMode;
  }

  const doneHideWindowMs = cleanNumber(payload.doneHideWindowMs);
  if (doneHideWindowMs !== null && doneHideWindowMs > 0) {
    next.doneHideWindowMs = doneHideWindowMs;
  }

  if (["deferred", "blocking", "off"].includes(payload.clipboardRestoreMode)) {
    next.clipboardRestoreMode = payload.clipboardRestoreMode;
  }

  const clipboardRestoreDelayMs = cleanNumber(payload.clipboardRestoreDelayMs);
  if (clipboardRestoreDelayMs !== null && clipboardRestoreDelayMs > 0) {
    next.clipboardRestoreDelayMs = clipboardRestoreDelayMs;
  }

  const pasteChunkChars = cleanNumber(payload.pasteChunkChars);
  if (pasteChunkChars !== null && pasteChunkChars >= 250) {
    next.pasteChunkChars = pasteChunkChars;
  }

  const pasteChunkDelayMs = cleanNumber(payload.pasteChunkDelayMs);
  if (pasteChunkDelayMs !== null && pasteChunkDelayMs >= 10) {
    next.pasteChunkDelayMs = pasteChunkDelayMs;
  }

  return next;
}

function pickMutable(settings) {
  return MUTABLE_KEYS.reduce((memo, key) => {
    if (settings[key] !== undefined) memo[key] = settings[key];
    return memo;
  }, {});
}

class RuntimeSettingsService {
  constructor({ filePath, defaults, logger }) {
    this.filePath = filePath;
    this.defaults = { ...defaults };
    this.logger = logger || console;
  }

  loadSync() {
    try {
      if (!fs.existsSync(this.filePath)) return { ...this.defaults };
      const saved = fs.readJsonSync(this.filePath);
      if (!saved || typeof saved !== "object") return { ...this.defaults };
      if (
        !saved._version &&
        saved.timeoutMs === LEGACY_DEFAULT_TIMEOUT_MS &&
        this.defaults.timeoutMs < LEGACY_DEFAULT_TIMEOUT_MS
      ) {
        saved.timeoutMs = this.defaults.timeoutMs;
      }
      if ((saved._version || 0) < SETTINGS_VERSION) {
        if (saved.previewIntervalMs === LEGACY_DEFAULT_PREVIEW_MS) {
          saved.previewIntervalMs = this.defaults.previewIntervalMs;
        }
        if (saved.polishMaxWords === LEGACY_DEFAULT_POLISH_MAX_WORDS) {
          saved.polishMaxWords = this.defaults.polishMaxWords;
        }
      }
      return applyRuntimeSettings(this.defaults, saved);
    } catch (error) {
      this.logger.warn?.(`[Settings] Failed to load saved settings: ${error.message}`);
      return { ...this.defaults };
    }
  }

  saveSync(settings) {
    const payload = { _version: SETTINGS_VERSION, ...pickMutable(settings) };
    fs.ensureDirSync(require("path").dirname(this.filePath));
    fs.writeJsonSync(this.filePath, payload, { spaces: 2 });
    return payload;
  }

  resetSync() {
    fs.removeSync(this.filePath);
    return { ...this.defaults };
  }
}

module.exports = {
  RuntimeSettingsService,
  createRuntimeDefaults,
  applyRuntimeSettings,
  pickMutable,
};
