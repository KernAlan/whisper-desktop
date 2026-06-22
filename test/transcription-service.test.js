const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("fs-extra");
const { TranscriptionService } = require("../src/main/services/transcription-service");

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
