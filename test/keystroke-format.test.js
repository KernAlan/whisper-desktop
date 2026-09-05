const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAccelerator,
  toSendKeys,
  toAppleScript,
  toXdotool,
  escapeSendKeysText,
  escapeAppleScriptText,
  escapePowerShellSingleQuoted,
  isSupportedAccelerator,
} = require("../src/main/services/keystroke-format");

test("accelerators split into modifiers and a single key", () => {
  const { modifiers, key } = parseAccelerator("CommandOrControl+Shift+V");
  assert.deepEqual([...modifiers].sort(), ["commandOrControl", "shift"]);
  assert.equal(key, "V");
});

test("a malformed accelerator is rejected rather than guessed at", () => {
  // Sending the wrong keystroke lands in whatever the user is typing in, so
  // these have to fail loudly at the edge.
  assert.throws(() => parseAccelerator(""), /empty/);
  assert.throws(() => parseAccelerator("Ctrl+"), /no key/);
  assert.throws(() => parseAccelerator("Ctrl+V+X"), /more than one key/);
  assert.throws(() => toSendKeys("Ctrl+F13"), /Unsupported key/);
});

test("SendKeys encodes modifiers and named keys", () => {
  assert.equal(toSendKeys("CommandOrControl+V"), "^v");
  assert.equal(toSendKeys("CommandOrControl+Shift+V"), "^+v");
  assert.equal(toSendKeys("Ctrl+Alt+Delete"), "^%{DELETE}");
  assert.equal(toSendKeys("Enter"), "{ENTER}");
  assert.equal(toSendKeys("Ctrl+Enter"), "^{ENTER}");
});

test("AppleScript encodes modifiers and key codes", () => {
  assert.equal(toAppleScript("CommandOrControl+V"), 'keystroke "v" using {command down}');
  assert.equal(
    toAppleScript("CommandOrControl+Shift+V"),
    'keystroke "v" using {command down, shift down}'
  );
  assert.equal(toAppleScript("Enter"), "key code 36");
  assert.equal(toAppleScript("Ctrl+Enter"), "key code 36 using {control down}");
});

test("xdotool encodes modifiers and key names", () => {
  assert.equal(toXdotool("CommandOrControl+V"), "ctrl+v");
  assert.equal(toXdotool("CommandOrControl+Shift+V"), "ctrl+shift+v");
  assert.equal(toXdotool("Enter"), "Return");
});

// CommandOrControl is the whole reason one setting can serve every platform.
test("CommandOrControl resolves per platform", () => {
  assert.equal(toSendKeys("CommandOrControl+V", "win32"), "^v");
  assert.equal(toAppleScript("CommandOrControl+V", "darwin"), 'keystroke "v" using {command down}');
  assert.equal(toXdotool("CommandOrControl+V", "linux"), "ctrl+v");
});

// Dictated text is arbitrary and reaches SendKeys, so its metacharacters have to
// be neutralised or the transcript starts pressing keys.
test("SendKeys text escaping neutralises metacharacters", () => {
  assert.equal(escapeSendKeysText("50% (a+b) ^x"), "50{%} {(}a{+}b{)} {^}x");
  assert.equal(escapeSendKeysText("a[1]{2}"), "a{[}1{]}{{}2{}}");
  assert.equal(escapeSendKeysText("~tilde"), "{~}tilde");
});

test("newlines become ENTER and carriage returns are dropped", () => {
  assert.equal(escapeSendKeysText("one\r\ntwo"), "one{ENTER}two");
  assert.equal(escapeSendKeysText("one\ntwo"), "one{ENTER}two");
  // Nothing may survive that would break the worker's line-based protocol.
  assert.ok(!escapeSendKeysText("a\r\nb").includes("\n"));
});

test("quotes stay data in PowerShell and AppleScript literals", () => {
  assert.equal(escapePowerShellSingleQuoted("it's"), "it''s");
  assert.equal(escapePowerShellSingleQuoted("'; rm -rf /; '"), "''; rm -rf /; ''");
  assert.equal(escapeAppleScriptText('say "hi"'), 'say \\"hi\\"');
  assert.equal(escapeAppleScriptText("back\\slash"), "back\\\\slash");
});

test("support can be checked without throwing", () => {
  assert.equal(isSupportedAccelerator("CommandOrControl+V", "win32"), true);
  assert.equal(isSupportedAccelerator("Ctrl+F13", "win32"), false);
  assert.equal(isSupportedAccelerator("", "win32"), false);
});
