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

// --- Output modes -----------------------------------------------------------

test("clipboard mode writes the text and sends no keystrokes", async () => {
  const calls = [];
  const clip = fakeClipboard();
  const typing = new TypingService({
    logger: { warn() {}, error() {} },
    outputMode: "clipboard",
    clipboardApi: clip,
    execFileRunner: async (...args) => {
      calls.push(args);
      return { stdout: "" };
    },
  });

  const result = await typing.pasteText("hello there");

  assert.equal(result.ok, true);
  assert.equal(result.outputMode, "clipboard");
  assert.equal(clip.readText(), "hello there");
  assert.deepEqual(calls, [], "clipboard mode must not send keystrokes");
});

// The whole point of typing mode is that it is the one path that leaves the
// clipboard alone, so an app that refuses a paste can still be dictated into.
test("typing mode never touches the clipboard", async () => {
  const sent = [];
  const clip = fakeClipboard("do not disturb");
  const typing = new TypingService({
    logger: { warn() {}, error() {} },
    outputMode: "type",
    clipboardApi: clip,
    targetContextService: {
      sendText: async (_ctx, text) => sent.push(text),
    },
  });

  const result = await typing.pasteText("typed output", { targetContext: { available: true } });

  assert.equal(result.ok, true);
  assert.equal(result.outputMode, "type");
  assert.deepEqual(sent, ["typed output"]);
  assert.equal(clip.readText(), "do not disturb");
});

test("typing mode falls back to the clipboard when it fails", async () => {
  const clip = fakeClipboard("original");
  const typing = new TypingService({
    logger: { warn() {}, error() {} },
    outputMode: "type",
    clipboardApi: clip,
    targetContextService: {
      sendText: async () => {
        throw new Error("target gone");
      },
    },
  });

  const result = await typing.pasteText("would be lost", { targetContext: { available: true } });

  assert.equal(result.ok, false);
  // Typing leaves nothing anywhere, so the text has to survive somewhere.
  assert.equal(clip.readText(), "would be lost");
});

test("the default paste shortcut keeps the existing paste path", async () => {
  const calls = [];
  const typing = new TypingService({
    logger: { warn() {}, error() {} },
    clipboardApi: fakeClipboard(),
    targetContextService: {
      sendPaste: async () => calls.push("sendPaste"),
      sendKeystroke: async (_ctx, accel) => calls.push(`sendKeystroke:${accel}`),
    },
  });

  await typing.pasteText("text", { targetContext: { available: true } });
  assert.deepEqual(calls, ["sendPaste"]);
});

test("a custom paste shortcut is sent as a keystroke instead", async () => {
  const calls = [];
  const typing = new TypingService({
    logger: { warn() {}, error() {} },
    clipboardApi: fakeClipboard(),
    pasteShortcut: "CommandOrControl+Shift+V",
    targetContextService: {
      sendPaste: async () => calls.push("sendPaste"),
      sendKeystroke: async (_ctx, accel) => calls.push(`sendKeystroke:${accel}`),
    },
  });

  await typing.pasteText("text", { targetContext: { available: true } });
  assert.deepEqual(calls, ["sendKeystroke:CommandOrControl+Shift+V"]);
});

test("setOutputConfig rejects values it does not understand", () => {
  const typing = service();
  typing.setOutputConfig({ outputMode: "telepathy", pasteShortcut: "   " });
  assert.equal(typing.outputMode, "paste");
  assert.equal(typing.pasteShortcut, "CommandOrControl+V");

  typing.setOutputConfig({ outputMode: "type", pasteShortcut: "Ctrl+Shift+V" });
  assert.equal(typing.outputMode, "type");
  assert.equal(typing.pasteShortcut, "Ctrl+Shift+V");
});

// --- Auto submit ------------------------------------------------------------

function submitHarness(overrides = {}) {
  const sent = [];
  const typing = new TypingService({
    logger: { warn() {}, error() {} },
    clipboardApi: fakeClipboard(),
    autoSubmitDelayMs: 0,
    targetContextService: {
      sendPaste: async () => sent.push("paste"),
      sendText: async () => sent.push("type"),
      sendKeystroke: async (_ctx, accel) => sent.push(`key:${accel}`),
    },
    ...overrides,
  });
  return { typing, sent };
}

test("auto submit is off by default", async () => {
  const { typing, sent } = submitHarness();
  const result = await typing.pasteText("hi", { targetContext: { available: true } });
  assert.deepEqual(sent, ["paste"]);
  assert.equal(result.submitted, undefined);
});

test("auto submit sends the chosen keystroke after the text", async () => {
  for (const [mode, expected] of [
    ["enter", "key:Enter"],
    ["ctrl-enter", "key:CommandOrControl+Enter"],
  ]) {
    const { typing, sent } = submitHarness({ autoSubmit: mode });
    const result = await typing.pasteText("hi", { targetContext: { available: true } });
    // Order matters: submitting before the text lands sends an empty message.
    assert.deepEqual(sent, ["paste", expected], mode);
    assert.equal(result.submitted, true);
  }
});

test("a custom submit keystroke is used when set", async () => {
  const { typing, sent } = submitHarness({
    autoSubmit: "custom",
    autoSubmitShortcut: "CommandOrControl+Shift+Enter",
  });
  await typing.pasteText("hi", { targetContext: { available: true } });
  assert.deepEqual(sent, ["paste", "key:CommandOrControl+Shift+Enter"]);
});

test("auto submit also follows typed output", async () => {
  const { typing, sent } = submitHarness({ outputMode: "type", autoSubmit: "enter" });
  await typing.pasteText("hi", { targetContext: { available: true } });
  assert.deepEqual(sent, ["type", "key:Enter"]);
});

// Nothing was inserted anywhere, so there is nothing to submit.
test("clipboard-only output never submits", async () => {
  const { typing, sent } = submitHarness({ outputMode: "clipboard", autoSubmit: "enter" });
  const result = await typing.pasteText("hi", { targetContext: { available: true } });
  assert.deepEqual(sent, []);
  assert.equal(result.submitted, undefined);
});

// The text is already in the field; a failed Enter must not report a failed insert.
test("a failed submit does not fail the insertion", async () => {
  const { typing } = submitHarness({
    autoSubmit: "enter",
    targetContextService: {
      sendPaste: async () => {},
      sendKeystroke: async () => {
        throw new Error("target gone");
      },
    },
  });
  const result = await typing.pasteText("hi", { targetContext: { available: true } });
  assert.equal(result.ok, true);
  assert.equal(result.submitted, false);
  assert.match(result.submitError, /target gone/);
});

test("setAutoSubmitConfig rejects values it does not understand", () => {
  const typing = service();
  typing.setAutoSubmitConfig({ autoSubmit: "yolo", autoSubmitShortcut: "  ", autoSubmitDelayMs: -5 });
  assert.equal(typing.autoSubmit, "off");
  assert.equal(typing.autoSubmitShortcut, "Enter");
  assert.equal(typing.autoSubmitDelayMs, 120);
});
