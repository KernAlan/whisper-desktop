const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("fs-extra");
const {
  RuntimeSettingsService,
  applyRuntimeSettings,
  pickMutable,
} = require("../src/main/services/runtime-settings-service");

function defaults() {
  return {
    shortcut: "CommandOrControl+Shift+Space",
    commandShortcut: "CommandOrControl+Shift+E",
    model: "whisper-large-v3-turbo",
    fallbackModel: "whisper-large-v3",
    textModel: "llama-3.1-8b-instant",
    polishChunkWords: 450,
    polishMaxWords: 2500,
    timeoutMs: 60000,
    maxQueue: 2,
    recorderTimesliceMs: 150,
    previewIntervalMs: 1500,
    dictationMode: "polished",
    doneHideWindowMs: 900,
    clipboardRestoreMode: "deferred",
    clipboardRestoreDelayMs: 120,
    pasteChunkChars: 1500,
    pasteChunkDelayMs: 80,
  };
}

test("applyRuntimeSettings accepts valid settings and ignores invalid values", () => {
  const next = applyRuntimeSettings(defaults(), {
    previewIntervalMs: 900,
    dictationMode: "fast",
    pasteChunkChars: 2000,
    pasteChunkDelayMs: 5,
    shortcut: "  Ctrl+Alt+Space  ",
  });

  assert.equal(next.previewIntervalMs, 1500);
  assert.equal(next.dictationMode, "fast");
  assert.equal(next.pasteChunkChars, 2000);
  assert.equal(next.pasteChunkDelayMs, 80);
  assert.equal(next.shortcut, "Ctrl+Alt+Space");
});

test("applyRuntimeSettings can disable command shortcut", () => {
  const next = applyRuntimeSettings(defaults(), {
    commandShortcut: " off ",
  });

  assert.equal(next.commandShortcut, "off");
});

test("RuntimeSettingsService saves and loads mutable settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-settings-"));
  const filePath = path.join(dir, "settings.json");
  const service = new RuntimeSettingsService({ filePath, defaults: defaults() });

  const saved = applyRuntimeSettings(defaults(), {
    dictationMode: "fast",
    previewIntervalMs: 2200,
    timeoutMs: 999,
  });
  service.saveSync(saved);

  const loaded = service.loadSync();
  assert.equal(loaded.dictationMode, "fast");
  assert.equal(loaded.previewIntervalMs, 2200);
  assert.equal(loaded.timeoutMs, 60000);
  assert.deepEqual(Object.keys(fs.readJsonSync(filePath)).sort(), Object.keys(pickMutable(saved)).sort());

  fs.removeSync(dir);
});

test("RuntimeSettingsService reset removes saved settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-settings-"));
  const filePath = path.join(dir, "settings.json");
  const service = new RuntimeSettingsService({ filePath, defaults: defaults() });

  service.saveSync(applyRuntimeSettings(defaults(), { dictationMode: "fast" }));
  const reset = service.resetSync();

  assert.equal(reset.dictationMode, "polished");
  assert.equal(fs.existsSync(filePath), false);

  fs.removeSync(dir);
});
