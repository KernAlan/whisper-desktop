const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("fs-extra");
const { WakeWordService, CLOSE_MODE } = require("../src/main/services/wake-word-service");
const { readTokenSet, toKeywordTokens } = require("../src/main/services/wake-keywords");

test("WakeWordService reports missing local model assets", () => {
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-wake-"));
  const service = new WakeWordService({ modelDir, logger: { log() {}, error() {} } });

  assert.throws(() => service.start(), /Wake model asset is missing/);
  fs.removeSync(modelDir);
});

test("WakeWordService stops after a local keyword match", () => {
  const detections = [];
  let finished = false;
  const service = new WakeWordService({
    modelDir: "unused",
    logger: { log() {}, error() {} },
    onDetected: (payload) => detections.push(payload),
  });
  service.keywordSpotters.set("wake", {
    createStream: () => ({
      acceptWaveform() {},
      inputFinished() {
        finished = true;
      },
    }),
    isReady: () => true,
    decode() {},
    getResult: () => ({ keyword: "Hey Whisper", start_time: 0.5 }),
    reset() {},
  });

  service.start();
  assert.equal(service.processFrame(new Float32Array(160)), true);
  assert.equal(service.getStatus().enabled, false);
  assert.equal(finished, true);
  assert.deepEqual(detections, [{ keyword: "Hey Whisper", mode: "wake", startTime: 0.5 }]);
});

test("WakeWordService supports the local close phrase", () => {
  const service = new WakeWordService({
    modelDir: "unused",
    logger: { log() {}, error() {} },
  });
  service.keywordSpotters.set(CLOSE_MODE, {
    createStream: () => ({ acceptWaveform() {} }),
  });

  const status = service.start({ mode: CLOSE_MODE });
  assert.equal(status.mode, CLOSE_MODE);
  assert.equal(status.keyword, "Stop Whisper");
});

test("shipped wake keyword assets match the phrases they are meant to spot", () => {
  const modelDir = path.join(__dirname, "..", "src", "main", "assets", "wake");
  const tokens = readTokenSet(path.join(modelDir, "tokens.txt"));

  // Regression: close-keywords.txt shipped as "▁S T O P ▁W H IS PER", which is
  // made of real tokens but is not the segmentation the model emits, so
  // "Stop Whisper" was never spotted and landed in the transcript instead.
  assert.equal(
    fs.readFileSync(path.join(modelDir, "keywords.txt"), "utf8").trim(),
    toKeywordTokens("Hey Whisper", tokens)
  );
  assert.equal(
    fs.readFileSync(path.join(modelDir, "close-keywords.txt"), "utf8").trim(),
    toKeywordTokens("Stop Whisper", tokens)
  );
  assert.equal(toKeywordTokens("Stop Whisper", tokens), "▁ST O P ▁W H IS PER");
});

test("toKeywordTokens rejects a phrase the model vocabulary cannot spell", () => {
  assert.throws(() => toKeywordTokens("stop", new Set(["▁ST", "O"])), /cannot be tokenized/);
});
