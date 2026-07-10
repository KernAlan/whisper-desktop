const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("node:os");
const path = require("node:path");
const { Logger } = require("../src/main/services/logger");

test("Logger bounds the active daily log file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-logs-"));
  const logFilePath = path.join(dir, "app.log");
  const logger = new Logger({
    logFilePath,
    maxFiles: 3,
    maxBytes: 140,
  });

  logger.log("first");
  await logger._writeQueue;
  logger.log("second");
  await logger._writeQueue;
  const before = fs.statSync(logger.getCurrentLogPath()).size;
  logger.log("third entry forces a bounded rollover");
  await logger._writeQueue;
  const after = fs.statSync(logger.getCurrentLogPath()).size;

  assert.ok(after <= 140);
  assert.ok(after < before + 60);
  fs.removeSync(dir);
});
