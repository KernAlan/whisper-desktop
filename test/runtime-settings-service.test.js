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
    textModel: "openai/gpt-oss-20b",
    polishChunkWords: 450,
    polishMaxWords: 10000,
    timeoutMs: 5000,
    maxQueue: 2,
    recorderTimesliceMs: 150,
    previewIntervalMs: 2500,
    dictationMode: "polished",
    doneHideWindowMs: 900,
    clipboardRestoreMode: "deferred",
    clipboardRestoreDelayMs: 120,
    pasteChunkChars: 1500,
    pasteChunkDelayMs: 80,
    wakePhraseEnabled: false,
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

  assert.equal(next.previewIntervalMs, 2500);
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

test("applyRuntimeSettings accepts the local wake phrase toggle", () => {
  const next = applyRuntimeSettings(defaults(), { wakePhraseEnabled: true });

  assert.equal(next.wakePhraseEnabled, true);
});

test("RuntimeSettingsService saves and loads mutable settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-settings-"));
  const filePath = path.join(dir, "settings.json");
  const service = new RuntimeSettingsService({ filePath, defaults: defaults() });

  const saved = applyRuntimeSettings(defaults(), {
    dictationMode: "fast",
    previewIntervalMs: 2200,
    timeoutMs: 12000,
  });
  service.saveSync(saved);

  const loaded = service.loadSync();
  assert.equal(loaded.dictationMode, "fast");
  assert.equal(loaded.previewIntervalMs, 2200);
  assert.equal(loaded.timeoutMs, 12000);
  assert.deepEqual(
    Object.keys(fs.readJsonSync(filePath)).sort(),
    ["_version", ...Object.keys(pickMutable(saved))].sort()
  );

  fs.removeSync(dir);
});

test("applyRuntimeSettings ignores too-low timeout", () => {
  const next = applyRuntimeSettings(defaults(), {
    timeoutMs: 999,
  });

  assert.equal(next.timeoutMs, 5000);
});

test("RuntimeSettingsService migrates old saved default timeout", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-settings-"));
  const filePath = path.join(dir, "settings.json");
  fs.writeJsonSync(filePath, { timeoutMs: 10000, dictationMode: "fast" });
  const service = new RuntimeSettingsService({ filePath, defaults: defaults() });

  const loaded = service.loadSync();

  assert.equal(loaded.timeoutMs, 5000);
  assert.equal(loaded.dictationMode, "fast");

  fs.removeSync(dir);
});

test("RuntimeSettingsService preserves explicit current-version timeout", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-settings-"));
  const filePath = path.join(dir, "settings.json");
  fs.writeJsonSync(filePath, { _version: 3, timeoutMs: 10000 });
  const service = new RuntimeSettingsService({ filePath, defaults: defaults() });

  const loaded = service.loadSync();

  assert.equal(loaded.timeoutMs, 10000);

  fs.removeSync(dir);
});

test("RuntimeSettingsService migrates legacy preview and meeting polish defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-settings-"));
  const filePath = path.join(dir, "settings.json");
  fs.writeJsonSync(filePath, {
    _version: 2,
    previewIntervalMs: 1500,
    polishMaxWords: 2500,
  });
  const service = new RuntimeSettingsService({ filePath, defaults: defaults() });

  const loaded = service.loadSync();

  assert.equal(loaded.previewIntervalMs, 2500);
  assert.equal(loaded.polishMaxWords, 10000);
  fs.removeSync(dir);
});

test("RuntimeSettingsService migrates a retired text model to the current default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-settings-"));
  const filePath = path.join(dir, "settings.json");
  fs.writeJsonSync(filePath, { _version: 3, textModel: "llama-3.1-8b-instant" });
  const service = new RuntimeSettingsService({
    filePath,
    defaults: defaults(),
    logger: { warn() {} },
  });

  const loaded = service.loadSync();

  assert.equal(loaded.textModel, "openai/gpt-oss-20b");
  fs.removeSync(dir);
});

test("RuntimeSettingsService keeps a supported saved text model", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-settings-"));
  const filePath = path.join(dir, "settings.json");
  fs.writeJsonSync(filePath, { _version: 3, textModel: "llama-3.3-70b-versatile" });
  const service = new RuntimeSettingsService({ filePath, defaults: defaults() });

  const loaded = service.loadSync();

  assert.equal(loaded.textModel, "llama-3.3-70b-versatile");
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

// The settings window autosaves its discrete controls by sending just the key
// that changed, so a patch must leave every other setting exactly as it was --
// including any half-typed hotkey sitting in the window at the time.
test("applyRuntimeSettings leaves untouched keys alone when given a patch", () => {
  const before = defaults();
  const after = applyRuntimeSettings(before, { wakePhraseEnabled: true });

  assert.equal(after.wakePhraseEnabled, true);
  for (const key of Object.keys(before)) {
    if (key === "wakePhraseEnabled") continue;
    assert.deepEqual(after[key], before[key], `patch changed ${key}`);
  }
});

test("a dictation mode patch does not disturb the hotkeys", () => {
  const before = { ...defaults(), shortcut: "CommandOrControl+Shift+Space" };
  const after = applyRuntimeSettings(before, { dictationMode: "fast" });

  assert.equal(after.dictationMode, "fast");
  assert.equal(after.shortcut, "CommandOrControl+Shift+Space");
  assert.equal(after.commandShortcut, before.commandShortcut);
});

// --- Dictation profiles -----------------------------------------------------

test("profiles are normalised and bounded", () => {
  const { sanitizeProfiles } = require("../src/main/services/runtime-settings-service");
  const profiles = sanitizeProfiles([
    { id: "a", name: "  Formal   email ", prompt: " Make it formal. ", hotkey: "CommandOrControl+1" },
    { name: "No id", prompt: "Bullet points" },
    { name: "Dropped", prompt: "" },
    { name: "", prompt: "also dropped" },
    { name: "Bad hotkey", prompt: "x", hotkey: "Nonsense+Q" },
  ]);

  assert.equal(profiles.length, 3);
  assert.equal(profiles[0].name, "Formal email");
  assert.equal(profiles[0].prompt, "Make it formal.");
  assert.equal(profiles[0].hotkey, "CommandOrControl+1");
  // A generated id, because one was not supplied.
  assert.ok(profiles[1].id);
  // An unusable hotkey is dropped rather than registered as something wrong.
  assert.equal(profiles[2].hotkey, "");
});

test("duplicate profile ids are replaced so selection stays unambiguous", () => {
  const { sanitizeProfiles } = require("../src/main/services/runtime-settings-service");
  const profiles = sanitizeProfiles([
    { id: "same", name: "One", prompt: "a" },
    { id: "same", name: "Two", prompt: "b" },
  ]);
  assert.equal(profiles.length, 2);
  assert.notEqual(profiles[0].id, profiles[1].id);
});

test("long profile fields are truncated and the list is capped", () => {
  const { sanitizeProfiles } = require("../src/main/services/runtime-settings-service");
  const [profile] = sanitizeProfiles([{ name: "n".repeat(200), prompt: "p".repeat(5000) }]);
  assert.equal(profile.name.length, 60);
  assert.equal(profile.prompt.length, 2000);

  const many = sanitizeProfiles(
    Array.from({ length: 50 }, (_, i) => ({ name: `p${i}`, prompt: "x" }))
  );
  assert.equal(many.length, 20);
});

test("selecting a profile that does not exist falls back to the standard polish", () => {
  const next = applyRuntimeSettings(defaults(), {
    dictationProfiles: [{ id: "keep", name: "Keep", prompt: "x" }],
    activeProfileId: "gone",
  });
  // Otherwise it would silently polish with the default rules while the UI
  // claimed a profile was active.
  assert.equal(next.activeProfileId, "");

  const chosen = applyRuntimeSettings(defaults(), {
    dictationProfiles: [{ id: "keep", name: "Keep", prompt: "x" }],
    activeProfileId: "keep",
  });
  assert.equal(chosen.activeProfileId, "keep");
});

test("the cycle shortcut can be cleared and rejects unusable keystrokes", () => {
  const base = { ...defaults(), profileCycleShortcut: "CommandOrControl+Alt+P" };
  assert.equal(applyRuntimeSettings(base, { profileCycleShortcut: "off" }).profileCycleShortcut, "");
  assert.equal(applyRuntimeSettings(base, { profileCycleShortcut: "" }).profileCycleShortcut, "");
  assert.equal(
    applyRuntimeSettings(base, { profileCycleShortcut: "Nonsense+Q" }).profileCycleShortcut,
    "CommandOrControl+Alt+P"
  );
});
