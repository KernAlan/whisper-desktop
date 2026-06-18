const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, validateConfig } = require("../src/shared/config");

test("loadConfig applies defaults", () => {
  const config = loadConfig({});
  assert.equal(config.shortcut, "CommandOrControl+Shift+Space");
  assert.equal(config.commandShortcut, "CommandOrControl+Shift+E");
  assert.equal(config.app.doneHideWindowMs, 900);
  assert.equal(config.app.previewIntervalMs, 2500);
  assert.equal(config.transcription.model, "whisper-large-v3-turbo");
  assert.equal(config.text.model, "llama-3.1-8b-instant");
  assert.equal(config.transcription.timeoutMs, 25000);
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

