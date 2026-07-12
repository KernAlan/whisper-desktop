const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, validateConfig } = require("../src/shared/config");

test("loadConfig applies defaults", () => {
  const config = loadConfig({});
  assert.equal(config.shortcut, "CommandOrControl+Shift+Space");
  assert.equal(config.commandShortcut, "CommandOrControl+Shift+E");
  assert.equal(config.app.doneHideWindowMs, 900);
  assert.equal(config.app.previewIntervalMs, 2500);
  assert.equal(config.app.dictationMode, "polished");
  assert.equal(config.app.wakePhraseEnabled, false);
  assert.equal(config.app.pasteChunkChars, 1500);
  assert.equal(config.app.pasteChunkDelayMs, 80);
  assert.equal(config.transcription.model, "whisper-large-v3-turbo");
  assert.equal(config.text.model, "llama-3.1-8b-instant");
  assert.equal(config.text.polishChunkWords, 450);
  assert.equal(config.text.polishMaxWords, 10000);
  assert.equal(config.transcription.timeoutMs, 5000);
});

test("validateConfig detects missing key", () => {
  const config = loadConfig({});
  const issues = validateConfig(config);
  assert.ok(issues.some((issue) => issue.includes("Missing GROQ_API_KEY")));
});

test("validateConfig detects preview interval that is too low", () => {
  const config = loadConfig({
    GROQ_API_KEY: "key",
    APP_PREVIEW_INTERVAL_MS: "500",
  });
  const issues = validateConfig(config);
  assert.ok(issues.some((issue) => issue.includes("APP_PREVIEW_INTERVAL_MS")));
});

test("validateConfig detects transcription timeout that is too low", () => {
  const config = loadConfig({
    GROQ_API_KEY: "key",
    GROQ_TRANSCRIPTION_TIMEOUT_MS: "2000",
  });
  const issues = validateConfig(config);
  assert.ok(issues.some((issue) => issue.includes("GROQ_TRANSCRIPTION_TIMEOUT_MS")));
});

test("validateConfig detects invalid dictation mode", () => {
  const config = loadConfig({
    GROQ_API_KEY: "key",
    APP_DICTATION_MODE: "fancy",
  });
  const issues = validateConfig(config);
  assert.ok(issues.some((issue) => issue.includes("APP_DICTATION_MODE")));
});

test("validateConfig detects invalid polish limits", () => {
  const config = loadConfig({
    GROQ_API_KEY: "key",
    GROQ_POLISH_CHUNK_WORDS: "50",
    GROQ_POLISH_MAX_WORDS: "40",
  });
  const issues = validateConfig(config);
  assert.ok(issues.some((issue) => issue.includes("GROQ_POLISH_CHUNK_WORDS")));
  assert.ok(issues.some((issue) => issue.includes("GROQ_POLISH_MAX_WORDS")));
});

test("validateConfig detects invalid paste chunk config", () => {
  const config = loadConfig({
    GROQ_API_KEY: "key",
    APP_PASTE_CHUNK_CHARS: "100",
    APP_PASTE_CHUNK_DELAY_MS: "5",
  });
  const issues = validateConfig(config);
  assert.ok(issues.some((issue) => issue.includes("APP_PASTE_CHUNK_CHARS")));
  assert.ok(issues.some((issue) => issue.includes("APP_PASTE_CHUNK_DELAY_MS")));
});

