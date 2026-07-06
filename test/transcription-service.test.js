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
