const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TypingService,
  MAC_PASTE_MENU_SCRIPT,
} = require("../src/main/services/typing-service");

function service() {
  return new TypingService({ logger: { warn() {}, error() {} } });
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
