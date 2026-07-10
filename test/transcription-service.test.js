const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("fs-extra");
const { TranscriptionService } = require("../src/main/services/transcription-service");

async function waitFor(assertion, timeoutMs = 1000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError || new Error("Timed out");
}

test("transcribe failure saves recovery file and returns recovery metadata", async () => {
  const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-recovery-"));
  const service = new TranscriptionService({
    apiKey: "test-key",
    model: "whisper-large-v3-turbo",
    fallbackModel: "whisper-large-v3",
    timeoutMs: 1000,
    maxQueue: 2,
    recoveryDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  service._transcribeOne = async () => {
    throw new Error("forced transcription failure");
  };

  await assert.rejects(
    service.transcribe(Buffer.from("not real audio")),
    (error) => {
      assert.match(error.message, /forced transcription failure/);
      assert.equal(error.recoveryFiles.length, 1);
      assert.match(error.recoveryFiles[0].name, /^recording-/);
      assert.equal(fs.existsSync(error.recoveryFiles[0].path), true);
      return true;
    }
  );

  fs.removeSync(recoveryDir);
});

test("final transcription aborts an in-flight preview request", async () => {
  const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-recovery-"));
  const signals = [];
  let calls = 0;
  const service = new TranscriptionService({
    apiKey: "test-key",
    model: "whisper-large-v3-turbo",
    fallbackModel: "whisper-large-v3",
    timeoutMs: 1000,
    maxQueue: 2,
    recoveryDir,
    logger: { log() {}, warn() {}, error() {} },
  });

  service.groq = {
    audio: {
      transcriptions: {
        create(_body, options = {}) {
          calls += 1;
          signals.push(options.signal);
          if (calls === 1) {
            return new Promise((_resolve, reject) => {
              options.signal.addEventListener("abort", () => reject(new Error("aborted preview")));
            });
          }
          return Promise.resolve("final text");
        },
      },
    },
  };

  const preview = service.transcribePreview(Buffer.from("preview audio"));
  await waitFor(() => assert.equal(signals.length, 1));

  const finalText = await service.transcribe(Buffer.from("final audio"));
  const previewResult = await preview;

  assert.equal(signals[0].aborted, true);
  assert.equal(previewResult.skipped, true);
  assert.equal(previewResult.text, "");
  assert.equal(finalText, "final text");

  fs.removeSync(recoveryDir);
});

test("_transcribeOne aborts the Groq request when its timeout expires", async () => {
  const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-recovery-"));
  const tempFile = path.join(recoveryDir, "audio.webm");
  await fs.writeFile(tempFile, Buffer.from("not real audio"));
  let aborted = false;
  const service = new TranscriptionService({
    apiKey: "test-key",
    model: "whisper-large-v3-turbo",
    fallbackModel: "whisper-large-v3",
    timeoutMs: 5,
    maxQueue: 2,
    recoveryDir,
    logger: { log() {}, warn() {}, error() {} },
  });

  service.groq = {
    audio: {
      transcriptions: {
        create(_body, options = {}) {
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("request aborted"));
            });
          });
        },
      },
    },
  };

  await assert.rejects(
    service._transcribeOne(tempFile),
    (error) => {
      assert.equal(error.code, "ETIMEDOUT");
      assert.match(error.message, /Transcription timed out after 5ms/);
      return true;
    }
  );
  assert.equal(aborted, true);

  fs.removeSync(recoveryDir);
});

test("preview transcription failures are skipped instead of thrown", async () => {
  const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-recovery-"));
  const warnings = [];
  const service = new TranscriptionService({
    apiKey: "test-key",
    model: "whisper-large-v3-turbo",
    fallbackModel: "whisper-large-v3",
    timeoutMs: 1000,
    maxQueue: 2,
    recoveryDir,
    logger: { log() {}, warn(message) { warnings.push(message); }, error() {} },
  });
  service._transcribeOne = async () => {
    throw new Error("forced preview failure");
  };

  const result = await service.transcribePreview(Buffer.from("not real audio"));

  assert.equal(result.skipped, true);
  assert.equal(result.text, "");
  assert.match(result.error, /forced preview failure/);
  assert.equal(warnings.length, 1);

  fs.removeSync(recoveryDir);
});

test("chunked recovery retries a saved session in order", async () => {
  const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-recovery-"));
  const service = new TranscriptionService({
    apiKey: "test-key",
    model: "whisper-large-v3-turbo",
    fallbackModel: "whisper-large-v3",
    timeoutMs: 1000,
    maxQueue: 2,
    recoveryDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  service._transcribeOne = async () => {
    throw new Error("forced chunk failure");
  };

  let savedError;
  await assert.rejects(
    service.transcribeChunked([Buffer.from("chunk one"), Buffer.from("chunk two")]),
    (error) => {
      savedError = error;
      assert.equal(error.recoveryFiles.length, 2);
      assert.equal(error.recoveryFiles[0].total, 2);
      assert.equal(error.recoveryFiles[0].sessionId, error.recoveryFiles[1].sessionId);
      assert.match(error.recoveryFiles[0].name, /part-001-of-002/);
      assert.match(error.recoveryFiles[1].name, /part-002-of-002/);
      return true;
    }
  );

  service._transcribeOne = async (fullPath) => ({
    text: path.basename(fullPath).includes("part-001") ? "one" : "two",
  });

  const text = await service.retryRecoveryFile("latest", { removeOnSuccess: false });
  assert.equal(text, "one two");
  assert.equal(fs.existsSync(savedError.recoveryFiles[0].path), true);
  assert.equal(fs.existsSync(savedError.recoveryFiles[1].path), true);

  const deleted = await service.deleteRecoveryTarget(savedError.recoveryFiles[0].sessionId);
  assert.equal(deleted, 2);
  assert.equal(fs.existsSync(savedError.recoveryFiles[0].path), false);
  assert.equal(fs.existsSync(savedError.recoveryFiles[1].path), false);

  fs.removeSync(recoveryDir);
});

test("checkpoint transcription persists a session until explicit cleanup", async () => {
  const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-recovery-"));
  const service = new TranscriptionService({
    apiKey: "test-key",
    model: "whisper-large-v3-turbo",
    fallbackModel: "whisper-large-v3",
    timeoutMs: 1000,
    maxQueue: 2,
    recoveryDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  service._transcribeOne = async (fullPath) => ({
    text: path.basename(fullPath).includes("segment-001") ? "first" : "second",
  });

  const first = await service.transcribeCheckpoint(Buffer.from("segment one"), {
    sessionId: "meeting-1",
    index: 0,
  });
  const second = await service.transcribeCheckpoint(Buffer.from("segment two"), {
    sessionId: "meeting-1",
    index: 1,
  });

  assert.equal(first.recovery.checkpoint, true);
  assert.equal(fs.existsSync(first.recovery.path), true);
  assert.equal(fs.existsSync(second.recovery.path), true);
  assert.equal(
    await service.retryRecoveryFile("meeting-1", { removeOnSuccess: false }),
    "first second"
  );
  assert.equal(await service.deleteRecoveryTarget("meeting-1"), 2);
  assert.equal(fs.existsSync(first.recovery.path), false);
  fs.removeSync(recoveryDir);
});

test("failed checkpoint transcription retains recoverable audio", async () => {
  const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-recovery-"));
  const service = new TranscriptionService({
    apiKey: "test-key",
    model: "whisper-large-v3-turbo",
    fallbackModel: "whisper-large-v3",
    timeoutMs: 1000,
    maxQueue: 2,
    recoveryDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  service._transcribeOne = async () => {
    throw new Error("offline");
  };

  await assert.rejects(
    service.transcribeCheckpoint(Buffer.from("segment"), {
      sessionId: "meeting-2",
      index: 0,
    }),
    (error) => {
      assert.equal(error.recoveryTarget, "meeting-2");
      assert.equal(error.recoveryFiles[0].checkpoint, true);
      assert.equal(fs.existsSync(error.recoveryFiles[0].path), true);
      return true;
    }
  );
  fs.removeSync(recoveryDir);
});

test("checkpoint sessions cannot grow beyond the recovery byte quota", async () => {
  const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-recovery-"));
  const service = new TranscriptionService({
    apiKey: "test-key",
    model: "whisper-large-v3-turbo",
    fallbackModel: "whisper-large-v3",
    timeoutMs: 1000,
    maxQueue: 2,
    recoveryDir,
    maxRecoveryBytes: 10,
    logger: { log() {}, warn() {}, error() {} },
  });
  service._transcribeOne = async () => ({ text: "ok" });

  await service.transcribeCheckpoint(Buffer.alloc(6), {
    sessionId: "bounded-meeting",
    index: 0,
  });
  await assert.rejects(
    service.transcribeCheckpoint(Buffer.alloc(6), {
      sessionId: "bounded-meeting",
      index: 1,
    }),
    /Could not persist the recording checkpoint/
  );

  const entries = await service.listRecoveryFiles();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].size, 6);
  fs.removeSync(recoveryDir);
});

test("recovery pruning enforces a byte quota while retaining the newest session", async () => {
  const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-recovery-"));
  const service = new TranscriptionService({
    apiKey: "test-key",
    model: "whisper-large-v3-turbo",
    fallbackModel: "whisper-large-v3",
    timeoutMs: 1000,
    maxQueue: 2,
    recoveryDir,
    maxRecoveryBytes: 32,
    logger: { log() {}, warn() {}, error() {} },
  });
  const oldPath = path.join(recoveryDir, "recording-old.webm");
  const newPath = path.join(recoveryDir, "recording-new.webm");
  fs.writeFileSync(oldPath, Buffer.alloc(24));
  fs.writeFileSync(newPath, Buffer.alloc(24));
  const oldTime = new Date(Date.now() - 10000);
  fs.utimesSync(oldPath, oldTime, oldTime);

  await service.pruneRecovery();

  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(newPath), true);
  fs.removeSync(recoveryDir);
});

test("recovery pruning removes expired sessions but keeps the newest session", async () => {
  const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-recovery-"));
  const service = new TranscriptionService({
    apiKey: "test-key",
    model: "whisper-large-v3-turbo",
    fallbackModel: "whisper-large-v3",
    timeoutMs: 1000,
    maxQueue: 2,
    recoveryDir,
    maxRecoveryAgeMs: 100,
    logger: { log() {}, warn() {}, error() {} },
  });
  const oldPath = path.join(recoveryDir, "recording-old.webm");
  const newPath = path.join(recoveryDir, "recording-new.webm");
  fs.writeFileSync(oldPath, Buffer.alloc(8));
  const oldTime = new Date(Date.now() - 10000);
  fs.utimesSync(oldPath, oldTime, oldTime);
  await new Promise((resolve) => setTimeout(resolve, 5));
  fs.writeFileSync(newPath, Buffer.alloc(8));

  await service.pruneRecovery();

  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(newPath), true);
  fs.removeSync(recoveryDir);
});
