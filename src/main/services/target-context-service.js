const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { PowerShellWorker } = require("./powershell-worker");
const {
  toSendKeys,
  toAppleScript,
  toXdotool,
  escapeSendKeysText,
  escapeAppleScriptText,
  escapePowerShellSingleQuoted,
} = require("./keystroke-format");

const execFileAsync = promisify(execFile);

// The same declarations as WINDOWS_NATIVE_TYPE, on one line. PowerShell reads the
// worker's stdin a statement at a time, so the type has to be a single-quoted
// one-liner rather than a here-string. C# does not care about the line breaks.
const WINDOWS_NATIVE_TYPE_INLINE =
  "using System; using System.Runtime.InteropServices; " +
  "public static class WhisperDesktopTarget { " +
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); ' +
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); ' +
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); ' +
  '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command); }';

// Compiled once per worker, then every capture and paste is a one-line call.
// The WScript.Shell COM object is built once here too; creating it per paste cost
// about 20ms on top of the process spawn.
const WINDOWS_WORKER_INIT = [
  "$ErrorActionPreference = 'Stop'",
  `Add-Type -TypeDefinition '${WINDOWS_NATIVE_TYPE_INLINE}'`,
  "$WDShell = New-Object -ComObject WScript.Shell",
  "function Invoke-WDShortcut { param($Target,$ProcId,$Keys,$Id) try { $t = [IntPtr]::new([int64]$Target); if ([WhisperDesktopTarget]::GetForegroundWindow() -ne $t) { [WhisperDesktopTarget]::ShowWindowAsync($t, 9) | Out-Null; if (-not [WhisperDesktopTarget]::SetForegroundWindow($t)) { $WDShell.AppActivate([int]$ProcId) | Out-Null }; Start-Sleep -Milliseconds 60 }; if ([WhisperDesktopTarget]::GetForegroundWindow() -ne $t) { throw 'target-window-not-foreground' }; $WDShell.SendKeys($Keys); Write-Output \"@@WD $Id OK\" } catch { Write-Output \"@@WD $Id ERR $($_.Exception.Message -replace '\s+', ' ')\" } }",
  "function Invoke-WDCapture { param($Id) try { $w = [WhisperDesktopTarget]::GetForegroundWindow(); if ($w -eq [IntPtr]::Zero) { throw 'no-foreground-window' }; $procId = [uint32]0; [WhisperDesktopTarget]::GetWindowThreadProcessId($w, [ref]$procId) | Out-Null; $p = Get-Process -Id $procId; $json = [pscustomobject]@{ windowId = $w.ToInt64().ToString(); processId = [int]$procId; appName = $p.ProcessName } | ConvertTo-Json -Compress; Write-Output \"@@WD $Id OK $json\" } catch { Write-Output \"@@WD $Id ERR $($_.Exception.Message -replace '\s+', ' ')\" } }",
].join(String.fromCharCode(10));

// After this many consecutive worker failures the service stops trying and uses
// the one-shot path, so a broken worker costs one timeout rather than one per paste.
const MAX_WORKER_FAILURES = 3;

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
    powerShellWorker,
    useWorker = true,
  } = {}) {
    this.platform = platform;
    this.execFileAsync = execFileRunner;
    this.readFile = readFile;
    this.logger = logger || console;
    this.workerFailures = 0;
    this.worker = null;
    if (platform === "win32" && useWorker) {
      this.worker = powerShellWorker || new PowerShellWorker({
        initScript: WINDOWS_WORKER_INIT,
        logger: this.logger,
      });
    }
  }

  // Called at startup so the Add-Type compile happens while the user is still
  // getting oriented, not on their first dictation.
  warmUp() {
    this.worker?.warmUp?.();
  }

  dispose() {
    this.worker?.dispose?.();
    this.worker = null;
  }

  // Returns null when the worker is unavailable or has failed too often, which
  // tells the caller to use the one-shot powershell.exe path instead.
  async _runOnWorker(command) {
    if (!this.worker || this.workerFailures >= MAX_WORKER_FAILURES) return null;
    try {
      const result = await this.worker.run(command);
      this.workerFailures = 0;
      return { ok: true, payload: result };
    } catch (error) {
      // A script-level error ("target-window-not-foreground") is a real answer,
      // not a broken worker, and must not trigger the fallback or the counter.
      if (error?.message && !/worker|spawn|ENOENT|EPIPE|timed out/i.test(error.message)) {
        return { ok: false, error };
      }
      this.workerFailures += 1;
      this.logger.warn?.(
        `[Target] PowerShell worker failed (${this.workerFailures}/${MAX_WORKER_FAILURES}): ${error.message}`
      );
      if (this.workerFailures >= MAX_WORKER_FAILURES) {
        this.logger.warn?.("[Target] Falling back to one-shot powershell.exe for the rest of the session.");
      }
      return null;
    }
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

  /** Sends an arbitrary accelerator, e.g. a configured paste or submit key. */
  async sendKeystroke(targetContext, accelerator) {
    const context = sanitizeTargetContext(targetContext, this.platform);
    if (!context?.available) {
      throw new Error("The original target application is unavailable. Text was kept on the clipboard.");
    }
    if (this.platform === "win32") {
      return this._sendWindowsKeys(context, toSendKeys(accelerator, this.platform));
    }
    if (this.platform === "darwin") {
      return this._sendMacClause(context, toAppleScript(accelerator, this.platform));
    }
    return this._sendLinuxKey(context, toXdotool(accelerator, this.platform));
  }

  /** Types literal text as keystrokes, leaving the clipboard untouched. */
  async sendText(targetContext, text) {
    const value = String(text ?? "");
    if (!value) return;
    const context = sanitizeTargetContext(targetContext, this.platform);
    if (!context?.available) {
      throw new Error("The original target application is unavailable. Text was kept on the clipboard.");
    }
    if (this.platform === "win32") {
      return this._sendWindowsKeys(context, escapeSendKeysText(value));
    }
    if (this.platform === "darwin") {
      return this._sendMacClause(context, `keystroke "${escapeAppleScriptText(value)}"`);
    }
    return this._sendLinuxText(context, value);
  }

  async _captureWindows() {
    const viaWorker = await this._runOnWorker("Invoke-WDCapture");
    if (viaWorker) {
      if (!viaWorker.ok) throw viaWorker.error;
      const context = sanitizeTargetContext(JSON.parse(viaWorker.payload), this.platform);
      if (!context?.windowId) throw new Error("No active window was found");
      return context;
    }
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
    return this._sendWindowsKeys(context, keys);
  }

  async _sendWindowsKeys(context, keys) {
    if (!context.windowId) throw new Error("The original target window cannot be restored.");
    // windowId and processId are digits-only out of sanitizeTargetContext. `keys`
    // can be dictated text, so it is escaped for the single-quoted PowerShell
    // literal it lands in -- and escapeSendKeysText has already turned any
    // newline into {ENTER}, which the worker's line-based protocol depends on.
    const safeKeys = escapePowerShellSingleQuoted(keys);
    const viaWorker = await this._runOnWorker(
      `Invoke-WDShortcut -Target ${context.windowId} -ProcId ${context.processId || 0} -Keys '${safeKeys}'`
    );
    if (viaWorker) {
      if (!viaWorker.ok) throw viaWorker.error;
      return;
    }

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
$shell.SendKeys('${safeKeys}')
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

  async _sendMacClause(context, clause) {
    if (!context.processId) throw new Error("The original target application cannot be restored.");
    const script = `tell application "System Events" to tell first application process whose unix id is ${context.processId}
set frontmost to true
delay 0.06
${clause}
end tell`;
    await this.execFileAsync("osascript", ["-e", script]);
  }

  async _sendLinuxKey(context, key) {
    if (!context.windowId) throw new Error("The original target window cannot be restored.");
    try {
      await this.execFileAsync("xdotool", [
        "windowactivate", "--sync", context.windowId, "key", "--clearmodifiers", key,
      ]);
    } catch (error) {
      const wrapped = new Error("The original Linux target could not be restored. Ensure xdotool is installed.");
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async _sendLinuxText(context, text) {
    if (!context.windowId) throw new Error("The original target window cannot be restored.");
    try {
      // `--` stops xdotool reading dictated text that starts with a dash as flags.
      await this.execFileAsync("xdotool", [
        "windowactivate", "--sync", context.windowId, "type", "--clearmodifiers", "--", text,
      ]);
    } catch (error) {
      const wrapped = new Error("The original Linux target could not be restored. Ensure xdotool is installed.");
      wrapped.cause = error;
      throw wrapped;
    }
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
  WINDOWS_WORKER_INIT,
  MAC_CAPTURE_SCRIPT,
  WINDOWS_CAPTURE_SCRIPT,
  TargetContextService,
  sanitizeTargetContext,
};
