const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const WINDOWS_NATIVE_TYPE = `
using System;
using System.Runtime.InteropServices;
public static class WhisperDesktopTarget {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
}
`;

const WINDOWS_CAPTURE_SCRIPT = `
Add-Type -TypeDefinition @'
${WINDOWS_NATIVE_TYPE}
'@
$window = [WhisperDesktopTarget]::GetForegroundWindow()
if ($window -eq [IntPtr]::Zero) { exit 2 }
$processId = [uint32]0
[WhisperDesktopTarget]::GetWindowThreadProcessId($window, [ref]$processId) | Out-Null
$process = Get-Process -Id $processId -ErrorAction Stop
[pscustomobject]@{
  windowId = $window.ToInt64().ToString()
  processId = [int]$processId
  appName = $process.ProcessName
} | ConvertTo-Json -Compress
`;

const MAC_CAPTURE_SCRIPT = `
tell application "System Events"
  set targetProcess to first application process whose frontmost is true
  return ((unix id of targetProcess) as text) & tab & (name of targetProcess)
end tell
`;

function safeInteger(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? text : "";
}

function sanitizeTargetContext(value, platform = process.platform) {
  if (!value || typeof value !== "object") return null;
  const windowId = safeInteger(value.windowId);
  const processId = safeInteger(value.processId);
  if (!windowId && !processId) return null;
  return {
    available: value.available !== false,
    platform: String(value.platform || platform).slice(0, 16),
    windowId,
    processId,
    appName: String(value.appName || "").replace(/[\r\n\t]/g, " ").slice(0, 100),
    capturedAt: Number(value.capturedAt || Date.now()),
    captureMs: Number(value.captureMs || 0),
  };
}

class TargetContextService {
  constructor({
    platform = process.platform,
    execFileRunner = execFileAsync,
    readFile = fs.readFile,
    logger,
  } = {}) {
    this.platform = platform;
    this.execFileAsync = execFileRunner;
    this.readFile = readFile;
    this.logger = logger || console;
  }

  async capture() {
    const startedAt = Date.now();
    try {
      const context = this.platform === "win32"
        ? await this._captureWindows()
        : this.platform === "darwin"
          ? await this._captureMac()
          : await this._captureLinux();
      return {
        ...context,
        available: true,
        platform: this.platform,
        capturedAt: Date.now(),
        captureMs: Date.now() - startedAt,
      };
    } catch (error) {
      this.logger.warn?.(`[Target] Failed to capture active application: ${error.message}`);
      return {
        available: false,
        platform: this.platform,
        windowId: "",
        processId: "",
        appName: "",
        capturedAt: Date.now(),
        captureMs: Date.now() - startedAt,
      };
    }
  }

  async sendPaste(targetContext) {
    return this._sendShortcut(targetContext, "paste");
  }

  async sendCopy(targetContext) {
    return this._sendShortcut(targetContext, "copy");
  }

  async sendUndo(targetContext) {
    return this._sendShortcut(targetContext, "undo");
  }

  async _captureWindows() {
    const { stdout } = await this.execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_CAPTURE_SCRIPT,
    ]);
    const payload = JSON.parse(String(stdout || "").trim());
    const context = sanitizeTargetContext(payload, this.platform);
    if (!context?.windowId) throw new Error("No active window was found");
    return context;
  }

  async _captureMac() {
    const { stdout } = await this.execFileAsync("osascript", ["-e", MAC_CAPTURE_SCRIPT]);
    const [processId, ...nameParts] = String(stdout || "").trim().split("\t");
    const context = sanitizeTargetContext({ processId, appName: nameParts.join(" ") }, this.platform);
    if (!context?.processId) throw new Error("No active application was found");
    return context;
  }

  async _captureLinux() {
    const { stdout: windowOutput } = await this.execFileAsync("xdotool", ["getactivewindow"]);
    const windowId = safeInteger(windowOutput);
    if (!windowId) throw new Error("No active window was found");
    const { stdout: processOutput } = await this.execFileAsync("xdotool", ["getwindowpid", windowId]);
    const processId = safeInteger(processOutput);
    let appName = "";
    if (processId) {
      appName = String(await this.readFile(`/proc/${processId}/comm`, "utf8")).trim();
    }
    return sanitizeTargetContext({ windowId, processId, appName }, this.platform);
  }

  async _sendShortcut(targetContext, operation) {
    const context = sanitizeTargetContext(targetContext, this.platform);
    if (!context?.available) {
      throw new Error("The original target application is unavailable. Text was kept on the clipboard.");
    }

    if (this.platform === "win32") {
      return this._sendWindowsShortcut(context, operation);
    }
    if (this.platform === "darwin") {
      return this._sendMacShortcut(context, operation);
    }
    return this._sendLinuxShortcut(context, operation);
  }

  async _sendWindowsShortcut(context, operation) {
    if (!context.windowId) throw new Error("The original target window cannot be restored.");
    const keys = { paste: "^v", copy: "^c", undo: "^z" }[operation];
    if (!keys) throw new Error(`Unsupported target operation: ${operation}`);
    const script = `
Add-Type -TypeDefinition @'
${WINDOWS_NATIVE_TYPE}
'@
$target = [IntPtr]::new([int64]${context.windowId})
$current = [WhisperDesktopTarget]::GetForegroundWindow()
if ($current -ne $target) {
  [WhisperDesktopTarget]::ShowWindowAsync($target, 9) | Out-Null
  $activated = [WhisperDesktopTarget]::SetForegroundWindow($target)
  if (-not $activated) {
    $shell = New-Object -ComObject WScript.Shell
    $shell.AppActivate(${context.processId || 0}) | Out-Null
  }
  Start-Sleep -Milliseconds 60
}
if ([WhisperDesktopTarget]::GetForegroundWindow() -ne $target) { exit 3 }
$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys('${keys}')
`;
    await this.execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
  }

  async _sendMacShortcut(context, operation) {
    if (!context.processId) throw new Error("The original target application cannot be restored.");
    const script = operation === "paste"
      ? `
tell application "System Events"
  set targetProcess to first application process whose unix id is ${context.processId}
  set frontmost of targetProcess to true
  delay 0.06
  tell targetProcess
    set pasteItem to menu item "Paste" of menu 1 of menu bar item "Edit" of menu bar 1
    if not (enabled of pasteItem) then error "Paste menu item is unavailable"
    click pasteItem
  end tell
end tell
`
      : `tell application "System Events" to tell first application process whose unix id is ${context.processId}
set frontmost to true
delay 0.06
keystroke "${operation === "copy" ? "c" : "z"}" using command down
end tell`;
    await this.execFileAsync("osascript", ["-e", script]);
  }

  async _sendLinuxShortcut(context, operation) {
    if (!context.windowId) throw new Error("The original target window cannot be restored.");
    const shortcut = { paste: "ctrl+v", copy: "ctrl+c", undo: "ctrl+z" }[operation];
    try {
      await this.execFileAsync("xdotool", [
        "windowactivate",
        "--sync",
        context.windowId,
        "key",
        "--clearmodifiers",
        shortcut,
      ]);
    } catch (error) {
      const wrapped = new Error("The original Linux target could not be restored. Ensure xdotool is installed.");
      wrapped.cause = error;
      throw wrapped;
    }
  }
}

module.exports = {
  MAC_CAPTURE_SCRIPT,
  WINDOWS_CAPTURE_SCRIPT,
  TargetContextService,
  sanitizeTargetContext,
};
