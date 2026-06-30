const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("fs-extra");
const { TranscriptStore } = require("../src/main/services/transcript-store");

test("TranscriptStore saves and reads latest transcript", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-transcripts-"));
  const store = new TranscriptStore({
    dir,
    logger: { warn() {} },
  });

  await store.save({
    text: "first transcript",
    timestamp: Date.now() - 1000,
    mode: "dictation",
  });
  await store.save({
    text: "second transcript",
    timestamp: Date.now(),
    mode: "dictation",
  });

  const latest = await store.latest();
  assert.equal(latest.text, "second transcript");
  assert.match(latest.name, /^transcript-/);

  fs.removeSync(dir);
});

test("TranscriptStore prunes old entries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-transcripts-"));
  const store = new TranscriptStore({
    dir,
    logger: { warn() {} },
    maxEntries: 2,
  });

  await store.save({ text: "one", timestamp: Date.now() - 2000 });
  await store.save({ text: "two", timestamp: Date.now() - 1000 });
  await store.save({ text: "three", timestamp: Date.now() });

  const entries = await store.list(10);
  assert.equal(entries.length, 2);

  fs.removeSync(dir);
});
