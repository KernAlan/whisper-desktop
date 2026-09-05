// Turns Electron accelerator strings ("CommandOrControl+Shift+V") into the three
// encodings the platforms actually take: SendKeys on Windows, AppleScript
// keystroke clauses on macOS, and xdotool key names on Linux.
//
// Every one of these ends up inside a shell or script string, so escaping is not
// cosmetic here. Dictated text is arbitrary user input that reaches SendKeys and
// osascript, and a stray quote in it has to stay data rather than becoming part
// of the command.

const MODIFIER_ALIASES = new Map([
  ["command", "meta"],
  ["cmd", "meta"],
  ["super", "meta"],
  ["meta", "meta"],
  ["control", "control"],
  ["ctrl", "control"],
  ["commandorcontrol", "commandOrControl"],
  ["cmdorctrl", "commandOrControl"],
  ["alt", "alt"],
  ["option", "alt"],
  ["altgr", "alt"],
  ["shift", "shift"],
]);

// SendKeys writes named keys in braces and gives these characters their own
// meaning, so a literal one has to be wrapped.
const SENDKEYS_RESERVED = new Set(["+", "^", "%", "~", "(", ")", "{", "}", "[", "]"]);

const SENDKEYS_NAMED_KEYS = new Map([
  ["enter", "{ENTER}"],
  ["return", "{ENTER}"],
  ["tab", "{TAB}"],
  ["space", " "],
  ["escape", "{ESC}"],
  ["esc", "{ESC}"],
  ["backspace", "{BACKSPACE}"],
  ["delete", "{DELETE}"],
  ["insert", "{INSERT}"],
  ["home", "{HOME}"],
  ["end", "{END}"],
  ["pageup", "{PGUP}"],
  ["pagedown", "{PGDN}"],
  ["up", "{UP}"],
  ["down", "{DOWN}"],
  ["left", "{LEFT}"],
  ["right", "{RIGHT}"],
]);

const APPLESCRIPT_NAMED_KEYS = new Map([
  ["enter", 36],
  ["return", 36],
  ["tab", 48],
  ["space", 49],
  ["escape", 53],
  ["esc", 53],
  ["delete", 51],
  ["backspace", 51],
  ["home", 115],
  ["end", 119],
  ["pageup", 116],
  ["pagedown", 121],
  ["up", 126],
  ["down", 125],
  ["left", 123],
  ["right", 124],
]);

const XDOTOOL_NAMED_KEYS = new Map([
  ["enter", "Return"],
  ["return", "Return"],
  ["tab", "Tab"],
  ["space", "space"],
  ["escape", "Escape"],
  ["esc", "Escape"],
  ["backspace", "BackSpace"],
  ["delete", "Delete"],
  ["insert", "Insert"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "Prior"],
  ["pagedown", "Next"],
  ["up", "Up"],
  ["down", "Down"],
  ["left", "Left"],
  ["right", "Right"],
]);

/**
 * Splits an accelerator into its modifiers and its single key.
 * Throws rather than guessing, so a bad setting is rejected at the edge instead
 * of silently sending the wrong keystroke into whatever the user is typing in.
 */
function parseAccelerator(accelerator) {
  const parts = String(accelerator || "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("Keystroke is empty");

  const modifiers = new Set();
  let key = "";

  for (const part of parts) {
    const alias = MODIFIER_ALIASES.get(part.toLowerCase());
    if (alias) {
      modifiers.add(alias);
      continue;
    }
    if (key) throw new Error(`Keystroke "${accelerator}" has more than one key`);
    key = part;
  }

  if (!key) throw new Error(`Keystroke "${accelerator}" has no key`);
  return { modifiers, key };
}

function resolveCommandOrControl(modifiers, platform) {
  const resolved = new Set(modifiers);
  if (resolved.delete("commandOrControl")) {
    resolved.add(platform === "darwin" ? "meta" : "control");
  }
  return resolved;
}

/** Escapes literal text so SendKeys types it instead of interpreting it. */
function escapeSendKeysText(text) {
  let out = "";
  for (const char of String(text ?? "")) {
    if (char === "\r") continue;
    if (char === "\n") {
      out += "{ENTER}";
      continue;
    }
    out += SENDKEYS_RESERVED.has(char) ? `{${char}}` : char;
  }
  return out;
}

/** Escapes a string for a single-quoted PowerShell literal. */
function escapePowerShellSingleQuoted(text) {
  return String(text ?? "").replace(/'/g, "''");
}

/** Escapes a string for an AppleScript double-quoted literal. */
function escapeAppleScriptText(text) {
  return String(text ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function toSendKeys(accelerator, platform = "win32") {
  const { modifiers, key } = parseAccelerator(accelerator);
  const resolved = resolveCommandOrControl(modifiers, platform);

  let prefix = "";
  // SendKeys has no Windows-key modifier, so meta falls back to control, which
  // is what CommandOrControl means on Windows anyway.
  if (resolved.has("control") || resolved.has("meta")) prefix += "^";
  if (resolved.has("alt")) prefix += "%";
  if (resolved.has("shift")) prefix += "+";

  const named = SENDKEYS_NAMED_KEYS.get(key.toLowerCase());
  if (named) return prefix + named;
  if (key.length !== 1) throw new Error(`Unsupported key for SendKeys: "${key}"`);
  const char = key.toLowerCase();
  return prefix + (SENDKEYS_RESERVED.has(char) ? `{${char}}` : char);
}

function toAppleScript(accelerator, platform = "darwin") {
  const { modifiers, key } = parseAccelerator(accelerator);
  const resolved = resolveCommandOrControl(modifiers, platform);

  const clauses = [];
  if (resolved.has("meta")) clauses.push("command down");
  if (resolved.has("control")) clauses.push("control down");
  if (resolved.has("alt")) clauses.push("option down");
  if (resolved.has("shift")) clauses.push("shift down");
  const using = clauses.length ? ` using {${clauses.join(", ")}}` : "";

  const keyCode = APPLESCRIPT_NAMED_KEYS.get(key.toLowerCase());
  if (keyCode !== undefined) return `key code ${keyCode}${using}`;
  if (key.length !== 1) throw new Error(`Unsupported key for AppleScript: "${key}"`);
  return `keystroke "${escapeAppleScriptText(key.toLowerCase())}"${using}`;
}

function toXdotool(accelerator, platform = "linux") {
  const { modifiers, key } = parseAccelerator(accelerator);
  const resolved = resolveCommandOrControl(modifiers, platform);

  const parts = [];
  if (resolved.has("control")) parts.push("ctrl");
  if (resolved.has("alt")) parts.push("alt");
  if (resolved.has("shift")) parts.push("shift");
  if (resolved.has("meta")) parts.push("super");

  const named = XDOTOOL_NAMED_KEYS.get(key.toLowerCase());
  if (named) {
    parts.push(named);
  } else if (key.length === 1) {
    parts.push(key.toLowerCase());
  } else {
    throw new Error(`Unsupported key for xdotool: "${key}"`);
  }
  return parts.join("+");
}

/** True when the accelerator can be encoded for the given platform. */
function isSupportedAccelerator(accelerator, platform = process.platform) {
  try {
    if (platform === "win32") toSendKeys(accelerator, platform);
    else if (platform === "darwin") toAppleScript(accelerator, platform);
    else toXdotool(accelerator, platform);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  parseAccelerator,
  toSendKeys,
  toAppleScript,
  toXdotool,
  escapeSendKeysText,
  escapeAppleScriptText,
  escapePowerShellSingleQuoted,
  isSupportedAccelerator,
};
