const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, validateConfig } = require("../src/shared/config");

test("loadConfig applies defaults", () => {
  const config = loadConfig({});
  assert.equal(config.shortcut, "CommandOrControl+Shift+Space");
  assert.equal(config.transcription.model, "whisper-large-v3-turbo");
  assert.equal(config.transcription.timeoutMs, 25000);
});

test("validateConfig detects missing key", () => {
  const config = loadConfig({});
  const issues = validateConfig(config);
  assert.ok(issues.some((issue) => issue.includes("Missing GROQ_API_KEY")));
});

