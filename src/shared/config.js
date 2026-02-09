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

  return {
    app: {
      hideWindowMs: toMs(env.APP_HIDE_WINDOW_MS, 5000),
      mediaRecorderTimesliceMs: toMs(env.APP_MEDIARECORDER_TIMESLICE_MS, 150),
      clipboardRestoreMode: env.APP_CLIPBOARD_RESTORE_MODE || "deferred",
      clipboardRestoreDelayMs: toMs(env.APP_CLIPBOARD_RESTORE_DELAY_MS, 120),
    },
    shortcut: env.APP_HOTKEY || "CommandOrControl+Shift+Space",
    transcription: {
      apiKey: env.GROQ_API_KEY || "",
      model: transcriptionModel,
      fallbackModel: fallbackTranscriptionModel,
      timeoutMs: toMs(env.GROQ_TRANSCRIPTION_TIMEOUT_MS, 25000),
      maxQueue: toInt(env.GROQ_TRANSCRIPTION_MAX_QUEUE, 2),
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
  if (config.transcription.timeoutMs < 1000) {
    issues.push("GROQ_TRANSCRIPTION_TIMEOUT_MS must be >= 1000");
  }
  if (!["deferred", "blocking", "off"].includes(config.app.clipboardRestoreMode)) {
    issues.push("APP_CLIPBOARD_RESTORE_MODE must be one of: deferred, blocking, off");
  }
  return issues;
}

module.exports = {
  loadConfig,
  validateConfig,
  maskApiKey,
};
