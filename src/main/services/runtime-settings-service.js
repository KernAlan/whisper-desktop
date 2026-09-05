const fs = require("fs-extra");
const { isSupportedAccelerator } = require("./keystroke-format");
const { randomUUID } = require("node:crypto");

const MAX_PROFILES = 20;
const MAX_PROFILE_NAME = 60;
const MAX_PROFILE_PROMPT = 2000;

/**
 * Normalises the saved profile list. Profiles come from the settings window and
 * from a JSON file a user can edit, so every field is bounded here rather than
 * trusted: the prompt goes into an LLM request and the hotkey into a global
 * shortcut registration.
 */
function sanitizeProfiles(value) {
  if (!Array.isArray(value)) return null;
  const seenIds = new Set();
  const profiles = [];

  for (const entry of value.slice(0, MAX_PROFILES)) {
    if (!entry || typeof entry !== "object") continue;
    const name = String(entry.name || "").replace(/\s+/g, " ").trim().slice(0, MAX_PROFILE_NAME);
    const prompt = String(entry.prompt || "").trim().slice(0, MAX_PROFILE_PROMPT);
    // A profile with no prompt has nothing to do, and one with no name cannot be
    // picked out of a list.
    if (!name || !prompt) continue;

    let id = String(entry.id || "").trim().slice(0, 64);
    if (!id || seenIds.has(id)) id = randomUUID();
    seenIds.add(id);

    const hotkey = String(entry.hotkey || "").trim();
    profiles.push({
      id,
      name,
      prompt,
      hotkey: hotkey && isSupportedAccelerator(hotkey) ? hotkey : "",
    });
  }
  return profiles;
}



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
  "outputMode",
  "pasteShortcut",
  "autoSubmit",
  "autoSubmitShortcut",
  "autoSubmitDelayMs",
  "dictationProfiles",
  "activeProfileId",
  "profileCycleShortcut",
  "clipboardRestoreDelayMs",
  "pasteChunkChars",
  "pasteChunkDelayMs",
  "wakePhraseEnabled",
];
const SETTINGS_VERSION = 4;
const LEGACY_DEFAULT_TIMEOUT_MS = 10000;
const LEGACY_DEFAULT_PREVIEW_MS = 1500;
const LEGACY_DEFAULT_POLISH_MAX_WORDS = 2500;
// Groq no longer serves these (llama-3.1-8b-instant was decommissioned 2026-08-16).
// A saved setting still pointing at one fails every polish and voice command, so
// migrate it back to the current default.
const RETIRED_TEXT_MODELS = new Set([
  "llama-3.1-8b-instant",
  "llama3-8b-8192",
  "llama3-70b-8192",
]);

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
    outputMode: config.app.outputMode,
    pasteShortcut: config.app.pasteShortcut,
    autoSubmit: config.app.autoSubmit,
    autoSubmitShortcut: config.app.autoSubmitShortcut,
    autoSubmitDelayMs: config.app.autoSubmitDelayMs,
    dictationProfiles: [],
    activeProfileId: "",
    profileCycleShortcut: config.app.profileCycleShortcut,
    clipboardRestoreDelayMs: config.app.clipboardRestoreDelayMs,
    pasteChunkChars: config.app.pasteChunkChars,
    pasteChunkDelayMs: config.app.pasteChunkDelayMs,
    wakePhraseEnabled: config.app.wakePhraseEnabled,
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

  if (typeof payload.wakePhraseEnabled === "boolean") {
    next.wakePhraseEnabled = payload.wakePhraseEnabled;
  }

  if (["paste", "type", "clipboard"].includes(payload.outputMode)) {
    next.outputMode = payload.outputMode;
  }

  const profiles = sanitizeProfiles(payload.dictationProfiles);
  if (profiles) next.dictationProfiles = profiles;

  if (typeof payload.activeProfileId === "string") {
    // Selecting a profile that is not in the list would silently polish with the
    // default rules, so an unknown id falls back to the standard prompt.
    const available = next.dictationProfiles || [];
    const wanted = payload.activeProfileId.trim();
    next.activeProfileId = available.some((p) => p.id === wanted) ? wanted : "";
  }

  if (typeof payload.profileCycleShortcut === "string") {
    const cycle = payload.profileCycleShortcut.trim();
    if (!cycle || cycle.toLowerCase() === "off") next.profileCycleShortcut = "";
    else if (isSupportedAccelerator(cycle)) next.profileCycleShortcut = cycle;
  }

  if (["off", "enter", "ctrl-enter", "custom"].includes(payload.autoSubmit)) {
    next.autoSubmit = payload.autoSubmit;
  }

  if (typeof payload.autoSubmitShortcut === "string" && payload.autoSubmitShortcut.trim()) {
    const submit = payload.autoSubmitShortcut.trim();
    if (isSupportedAccelerator(submit)) next.autoSubmitShortcut = submit;
  }

  const autoSubmitDelayMs = cleanNumber(payload.autoSubmitDelayMs);
  if (autoSubmitDelayMs !== null && autoSubmitDelayMs >= 0) {
    next.autoSubmitDelayMs = autoSubmitDelayMs;
  }

  // A keystroke that cannot be encoded would be sent into whatever the user is
  // typing in, so an unusable one is dropped and the old setting stands.
  if (typeof payload.pasteShortcut === "string" && payload.pasteShortcut.trim()) {
    const shortcut = payload.pasteShortcut.trim();
    if (isSupportedAccelerator(shortcut)) next.pasteShortcut = shortcut;
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
        if (RETIRED_TEXT_MODELS.has(cleanString(saved.textModel))) {
          this.logger.warn?.(
            `[Settings] Text model ${saved.textModel} is retired; switching to ${this.defaults.textModel}.`
          );
          saved.textModel = this.defaults.textModel;
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
  sanitizeProfiles,
  RuntimeSettingsService,
  createRuntimeDefaults,
  applyRuntimeSettings,
  pickMutable,
};
