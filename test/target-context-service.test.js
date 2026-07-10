const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TargetContextService,
  sanitizeTargetContext,
} = require("../src/main/services/target-context-service");

test("sanitizeTargetContext keeps only safe target metadata", () => {
  assert.deepEqual(
    sanitizeTargetContext({
      available: true,
      platform: "win32",
      windowId: "1234",
      processId: 99,
      appName: "Code\r\nprivate title",
      ignored: "secret",
      capturedAt: 10,
    }, "win32"),
    {
      available: true,
      platform: "win32",
      windowId: "1234",
      processId: "99",
      appName: "Code  private title",
      capturedAt: 10,
      captureMs: 0,
    }
  );
  assert.equal(sanitizeTargetContext({ windowId: "not-a-number" }, "win32"), null);
});

test("Windows capture returns an opaque target without a window title", async () => {
  const service = new TargetContextService({
    platform: "win32",
    logger: { warn() {} },
    execFileRunner: async () => ({
      stdout: JSON.stringify({ windowId: "4321", processId: 77, appName: "Code" }),
    }),
  });

  const context = await service.capture();

  assert.equal(context.available, true);
  assert.equal(context.windowId, "4321");
  assert.equal(context.processId, "77");
  assert.equal(context.appName, "Code");
  assert.equal("title" in context, false);
});

test("Windows paste restores the captured numeric target before sending keys", async () => {
  const calls = [];
  const service = new TargetContextService({
    platform: "win32",
    logger: { warn() {} },
    execFileRunner: async (file, args) => calls.push({ file, args }),
  });

  await service.sendPaste({
    available: true,
    platform: "win32",
    windowId: "4321",
    processId: "77",
    appName: "Code",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell.exe");
  assert.match(calls[0].args.at(-1), /4321/);
  assert.match(calls[0].args.at(-1), /SendKeys\('\^v'\)/);
});

test("target operations fail closed when capture was unavailable", async () => {
  const service = new TargetContextService({
    platform: "win32",
    logger: { warn() {} },
    execFileRunner: async () => {
      throw new Error("should not execute");
    },
  });

  await assert.rejects(
    service.sendPaste({ available: false, platform: "win32" }),
    /original target application is unavailable/
  );
});

test("Linux paste activates the captured window before inserting", async () => {
  const calls = [];
  const service = new TargetContextService({
    platform: "linux",
    logger: { warn() {} },
    execFileRunner: async (file, args) => calls.push({ file, args }),
  });

  await service.sendPaste({
    available: true,
    platform: "linux",
    windowId: "101",
    processId: "202",
  });

  assert.deepEqual(calls, [{
    file: "xdotool",
    args: ["windowactivate", "--sync", "101", "key", "--clearmodifiers", "ctrl+v"],
  }]);
});
