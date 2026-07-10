function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toMs(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function maskApiKey(key) {
  if (!key) return "missing";
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function loadConfig(env = process.env) {
  const transcriptionModel = env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3-turbo";
  const fallbackTranscriptionModel =
    env.GROQ_FALLBACK_TRANSCRIPTION_MODEL || "whisper-large-v3";
  const textModel = env.GROQ_TEXT_MODEL || "llama-3.1-8b-instant";

  return {
    app: {
      hideWindowMs: toMs(env.APP_HIDE_WINDOW_MS, 5000),
      doneHideWindowMs: toMs(env.APP_DONE_HIDE_WINDOW_MS, 900),
      mediaRecorderTimesliceMs: toMs(env.APP_MEDIARECORDER_TIMESLICE_MS, 150),
      previewIntervalMs: toMs(env.APP_PREVIEW_INTERVAL_MS, 2500),
      dictationMode: env.APP_DICTATION_MODE || "polished",
      clipboardRestoreMode: env.APP_CLIPBOARD_RESTORE_MODE || "deferred",
      clipboardRestoreDelayMs: toMs(env.APP_CLIPBOARD_RESTORE_DELAY_MS, 120),
      pasteChunkChars: toInt(env.APP_PASTE_CHUNK_CHARS, 1500),
      pasteChunkDelayMs: toMs(env.APP_PASTE_CHUNK_DELAY_MS, 80),
    },
    shortcut: env.APP_HOTKEY || "CommandOrControl+Shift+Space",
    commandShortcut: env.APP_COMMAND_HOTKEY || "CommandOrControl+Shift+E",
    transcription: {
      apiKey: env.GROQ_API_KEY || "",
      model: transcriptionModel,
      fallbackModel: fallbackTranscriptionModel,
      timeoutMs: toMs(env.GROQ_TRANSCRIPTION_TIMEOUT_MS, 5000),
      maxQueue: toInt(env.GROQ_TRANSCRIPTION_MAX_QUEUE, 2),
    },
    text: {
      apiKey: env.GROQ_API_KEY || "",
      model: textModel,
      timeoutMs: toMs(env.GROQ_TEXT_TIMEOUT_MS, 20000),
      polishChunkWords: toInt(env.GROQ_POLISH_CHUNK_WORDS, 450),
      polishMaxWords: toInt(env.GROQ_POLISH_MAX_WORDS, 10000),
    },
  };
}

function validateConfig(config) {
  const issues = [];
  if (!config.transcription.apiKey) {
    issues.push("Missing GROQ_API_KEY");
  }
  if (config.transcription.maxQueue < 1) {
    issues.push("GROQ_TRANSCRIPTION_MAX_QUEUE must be >= 1");
  }
  if (config.transcription.timeoutMs < 3000) {
    issues.push("GROQ_TRANSCRIPTION_TIMEOUT_MS must be >= 3000");
  }
  if (!["deferred", "blocking", "off"].includes(config.app.clipboardRestoreMode)) {
    issues.push("APP_CLIPBOARD_RESTORE_MODE must be one of: deferred, blocking, off");
  }
  if (config.app.previewIntervalMs < 1000) {
    issues.push("APP_PREVIEW_INTERVAL_MS must be >= 1000");
  }
  if (!["fast", "polished"].includes(config.app.dictationMode)) {
    issues.push("APP_DICTATION_MODE must be one of: fast, polished");
  }
  if (config.app.pasteChunkChars < 250) {
    issues.push("APP_PASTE_CHUNK_CHARS must be >= 250");
  }
  if (config.app.pasteChunkDelayMs < 10) {
    issues.push("APP_PASTE_CHUNK_DELAY_MS must be >= 10");
  }
  if (config.text.polishChunkWords < 100) {
    issues.push("GROQ_POLISH_CHUNK_WORDS must be >= 100");
  }
  if (config.text.polishMaxWords < config.text.polishChunkWords) {
    issues.push("GROQ_POLISH_MAX_WORDS must be >= GROQ_POLISH_CHUNK_WORDS");
  }
  return issues;
}

module.exports = {
  loadConfig,
  validateConfig,
  maskApiKey,
};
