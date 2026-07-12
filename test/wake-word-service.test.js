const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("fs-extra");
const { WakeWordService, CLOSE_MODE } = require("../src/main/services/wake-word-service");

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
