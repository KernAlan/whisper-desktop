const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TypingService,
  MAC_PASTE_MENU_SCRIPT,
} = require("../src/main/services/typing-service");

function service() {
  return new TypingService({ logger: { warn() {}, error() {} } });
}

function fakeClipboard(initialText = "original clipboard") {
  let text = initialText;
  return {
    availableFormats: () => ["text/plain"],
    readBuffer: () => Buffer.from(text, "utf8"),
    writeBuffer: (_format, data) => { text = Buffer.from(data).toString("utf8"); },
    clear: () => { text = ""; },
    writeText: (value) => { text = String(value); },
    readText: () => text,
    getText: () => text,
  };
}

test("splitTextForPaste keeps short text as one chunk", () => {
  const typing = service();
  assert.deepEqual(typing._splitTextForPaste("hello world", 1500), ["hello world"]);
});

test("splitTextForPaste preserves text exactly across chunks", () => {
  const typing = service();
  const text = "First sentence. Second sentence is longer.\n\nThird paragraph keeps going.";
  const chunks = typing._splitTextForPaste(text, 28);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text);
});

test("mac paste uses the foreground app Paste menu instead of typing v", async () => {
  const calls = [];
  const typing = new TypingService({
    logger: { warn() {}, error() {} },
    platform: "darwin",
    execFileRunner: async (file, args) => {
      calls.push({ file, args });
    },
  });

  await typing._sendPasteShortcut();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "osascript");
  assert.deepEqual(calls[0].args, ["-e", MAC_PASTE_MENU_SCRIPT]);
  assert.equal(calls[0].args.join(" ").includes('keystroke "v"'), false);
});

test("mac paste reports failure when the Paste menu is unavailable", async () => {
  const typing = new TypingService({
    logger: { warn() {}, error() {} },
    platform: "darwin",
    execFileRunner: async () => {
      throw new Error("Paste menu item is not available");
    },
  });

  await assert.rejects(
    typing._sendPasteShortcut(),
    /Paste menu item is not available/
  );
});

test("Windows paste uses a native PowerShell SendKeys command", async () => {
  const calls = [];
  const typing = new TypingService({
    logger: { warn() {}, error() {} },
    platform: "win32",
    execFileRunner: async (file, args) => calls.push({ file, args }),
  });

  await typing._sendPasteShortcut();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell.exe");
  assert.ok(calls[0].args.includes("-NonInteractive"));
  assert.match(calls[0].args.at(-1), /SendKeys\('\^v'\)/);
});

test("Linux paste uses xdotool without shell interpolation", async () => {
  const calls = [];
  const typing = new TypingService({
    logger: { warn() {}, error() {} },
    platform: "linux",
    execFileRunner: async (file, args) => calls.push({ file, args }),
  });

  await typing._sendPasteShortcut();

  assert.deepEqual(calls, [{
    file: "xdotool",
    args: ["key", "--clearmodifiers", "ctrl+v"],
  }]);
});

test("Linux paste explains the xdotool requirement", async () => {
  const typing = new TypingService({
    logger: { warn() {}, error() {} },
    platform: "linux",
    execFileRunner: async () => {
      throw new Error("ENOENT");
    },
  });

  await assert.rejects(typing._sendPasteShortcut(), /requires xdotool/);
});

test("paste restores the previous clipboard by default", async () => {
  const clipboardApi = fakeClipboard();
  const typing = new TypingService({
    logger: { warn() {}, error() {} },
    platform: "linux",
    restoreMode: "blocking",
    restoreDelayMs: 1,
    clipboardApi,
    execFileRunner: async () => {},
  });

  const result = await typing.pasteText("inserted text");

  assert.equal(result.ok, true);
  assert.equal(clipboardApi.getText(), "original clipboard");
});

test("paste failure also restores the previous clipboard", async () => {
  const clipboardApi = fakeClipboard();
  const typing = new TypingService({
    logger: { warn() {}, error() {} },
    platform: "linux",
    restoreMode: "blocking",
    restoreDelayMs: 1,
    clipboardApi,
    execFileRunner: async () => { throw new Error("paste unavailable"); },
  });

  const result = await typing.pasteText("uninserted text");

  assert.equal(result.ok, false);
  assert.equal(clipboardApi.getText(), "original clipboard");
});
