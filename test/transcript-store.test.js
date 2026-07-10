const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("fs-extra");
const { TranscriptStore } = require("../src/main/services/transcript-store");

function createStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-transcripts-"));
  return {
    dir,
    store: new TranscriptStore({ dir, logger: { warn() {} }, ...options }),
  };
}

test("TranscriptStore saves a reversible structured transaction", async () => {
  const { dir, store } = createStore();

  await store.save({
    rawText: "raw dictated words",
    finalText: "Raw dictated words.",
    timestamp: Date.now(),
    mode: "dictation",
    target: { platform: "win32", appName: "Code", windowId: "123" },
    paste: { ok: true, chunks: 1, pasteMs: 120, targetRestored: true },
    polished: true,
  });

  const latest = await store.latest();
  assert.equal(latest.text, "Raw dictated words.");
  assert.equal(latest.rawText, "raw dictated words");
  assert.equal(latest.target.appName, "Code");
  assert.deepEqual(latest.paste, {
    ok: true,
    chunks: 1,
    pasteMs: 120,
    restoreMs: 0,
    targetRestored: true,
  });
  assert.match(latest.name, /^transcript-.*\.json$/);

  const undone = await store.markUndone(latest.id);
  assert.equal(undone.undone, true);

  fs.removeSync(dir);
});

test("TranscriptStore reads legacy text history", async () => {
  const { dir, store } = createStore();
  const legacyPath = path.join(dir, "transcript-legacy-dictation.txt");
  fs.writeFileSync(legacyPath, "legacy transcript", "utf8");

  const latest = await store.latest();
  assert.equal(latest.format, "legacy");
  assert.equal(latest.text, "legacy transcript");

  fs.removeSync(dir);
});

test("TranscriptStore prunes old entries by count", async () => {
  const { dir, store } = createStore({ maxEntries: 2 });

  await store.save({ text: "one", timestamp: Date.now() - 2000 });
  await store.save({ text: "two", timestamp: Date.now() - 1000 });
  await store.save({ text: "three", timestamp: Date.now() });

  const entries = await store.list(10);
  assert.equal(entries.length, 2);

  fs.removeSync(dir);
});

test("TranscriptStore keeps transactions distinct when timestamps match", async () => {
  const { dir, store } = createStore();
  const timestamp = Date.now();

  await store.save({ text: "first", timestamp });
  await store.save({ text: "second", timestamp });

  const entries = await store.list(10);
  assert.equal(entries.length, 2);
  assert.deepEqual(new Set(entries.map((entry) => entry.text)), new Set(["first", "second"]));

  fs.removeSync(dir);
});

test("TranscriptStore records an undo that arrives before asynchronous history save", async () => {
  const { dir, store } = createStore();
  await store.markUndone("transaction-before-save");
  await store.save({ id: "transaction-before-save", text: "undo me" });

  assert.equal((await store.latest()).undone, true);
  fs.removeSync(dir);
});

test("TranscriptStore keeps only the newest transaction when the byte cap is exceeded", async () => {
  const { dir, store } = createStore({ maxEntries: 10, maxBytes: 1 });

  await store.save({ text: "first entry" });
  await store.save({ text: "second entry" });

  const entries = await store.list(10);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "second entry");

  fs.removeSync(dir);
});

test("TranscriptStore prunes expired transactions", async () => {
  const { dir, store } = createStore({ maxAgeMs: 1 });
  const oldPath = path.join(dir, "transcript-old-dictation.txt");
  fs.writeFileSync(oldPath, "expired", "utf8");
  const oldTime = new Date(Date.now() - 10000);
  fs.utimesSync(oldPath, oldTime, oldTime);

  await store.save({ text: "fresh" });
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal((await store.latest()).text, "fresh");

  fs.removeSync(dir);
});
