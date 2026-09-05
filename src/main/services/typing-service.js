const { clipboard } = require("electron");
const {
  toSendKeys,
  toAppleScript,
  toXdotool,
  escapeSendKeysText,
  escapeAppleScriptText,
  escapePowerShellSingleQuoted,
} = require("./keystroke-format");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

const MAC_PASTE_MENU_SCRIPT = `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  tell frontApp
    try
      set pasteItem to menu item "Paste" of menu 1 of menu bar item "Edit" of menu bar 1
      if enabled of pasteItem then
        click pasteItem
        return "pasted"
      end if
    end try
  end tell
end tell
error "Paste menu item is not available"
`;

class TypingService {
  constructor({
    logger,
    restoreMode = "deferred",
    restoreDelayMs = 120,
    pasteChunkChars = 1500,
    pasteChunkDelayMs = 80,
    outputMode = "paste",
    pasteShortcut = "CommandOrControl+V",
    platform = process.platform,
    execFileRunner = execFileAsync,
    targetContextService = null,
    clipboardApi = clipboard,
  }) {
    this.logger = logger || console;
    this.restoreMode = restoreMode;
    this.restoreDelayMs = restoreDelayMs;
    this.pasteChunkChars = pasteChunkChars;
    this.pasteChunkDelayMs = pasteChunkDelayMs;
    this.outputMode = outputMode;
    this.pasteShortcut = pasteShortcut;
    this.platform = platform;
    this.execFileAsync = execFileRunner;
    this.targetContextService = targetContextService;
    this.clipboard = clipboardApi;
  }

  setRestoreConfig({ restoreMode, restoreDelayMs }) {
    if (restoreMode) this.restoreMode = restoreMode;
    if (Number.isFinite(restoreDelayMs) && restoreDelayMs > 0) {
      this.restoreDelayMs = restoreDelayMs;
    }
  }

  setOutputConfig({ outputMode, pasteShortcut }) {
    if (["paste", "type", "clipboard"].includes(outputMode)) {
      this.outputMode = outputMode;
    }
    if (typeof pasteShortcut === "string" && pasteShortcut.trim()) {
      this.pasteShortcut = pasteShortcut.trim();
    }
  }

  setPasteConfig({ pasteChunkChars, pasteChunkDelayMs }) {
    if (Number.isFinite(pasteChunkChars) && pasteChunkChars >= 250) {
      this.pasteChunkChars = pasteChunkChars;
    }
    if (Number.isFinite(pasteChunkDelayMs) && pasteChunkDelayMs >= 10) {
      this.pasteChunkDelayMs = pasteChunkDelayMs;
    }
  }

  async pasteText(text, { onProgress, keepTextOnClipboard = false, targetContext } = {}) {
    if (this.outputMode === "clipboard") return this._deliverToClipboard(text);
    if (this.outputMode === "type") return this._deliverByTyping(text, { onProgress, targetContext });
    return this._deliverByPaste(text, { onProgress, keepTextOnClipboard, targetContext });
  }

  // Clipboard only: nothing is sent to the target, so there is no focus handoff
  // to get wrong and no app that can refuse the paste.
  async _deliverToClipboard(text) {
    const finalText = String(text || "");
    const startedAt = Date.now();
    try {
      this.clipboard.writeText(finalText);
      return {
        ok: true,
        outputMode: "clipboard",
        pasteMs: Date.now() - startedAt,
        restoreMs: 0,
        restoreMode: this.restoreMode,
        chunks: 1,
        targetRestored: false,
      };
    } catch (error) {
      this.logger.error("Failed to write to the clipboard:", error);
      return {
        ok: false,
        outputMode: "clipboard",
        error: error?.message || "Could not write to the clipboard",
        pasteMs: 0,
        restoreMs: 0,
        restoreMode: this.restoreMode,
        chunks: 0,
        targetRestored: false,
      };
    }
  }

  // Keystroke simulation: the clipboard is never touched, which is the point --
  // it is the only mode that leaves it alone entirely, and the fallback for apps
  // that refuse a clipboard paste. It is much slower than pasting, so the text is
  // still chunked to keep any one call short.
  async _deliverByTyping(text, { onProgress, targetContext } = {}) {
    const finalText = String(text || "");
    const startedAt = Date.now();
    const chunks = this._splitTextForPaste(finalText, this.pasteChunkChars);
    try {
      for (let i = 0; i < chunks.length; i += 1) {
        if (typeof onProgress === "function") {
          onProgress({ index: i + 1, total: chunks.length, chars: chunks[i].length });
        }
        await this._sendText(chunks[i], targetContext);
        if (chunks.length > 1 && i < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, this.pasteChunkDelayMs));
        }
      }
      return {
        ok: true,
        outputMode: "type",
        pasteMs: Date.now() - startedAt,
        restoreMs: 0,
        restoreMode: this.restoreMode,
        chunks: chunks.length,
        targetRestored: Boolean(targetContext?.available),
      };
    } catch (error) {
      // Typing left nothing anywhere, so the text would otherwise be lost.
      try {
        this.clipboard.writeText(finalText);
      } catch (clipboardError) {
        this.logger.warn("Failed to keep text on clipboard after typing error:", clipboardError);
      }
      this.logger.error("Error typing text:", error);
      return {
        ok: false,
        outputMode: "type",
        error: error?.message || "Typing failed",
        pasteMs: Date.now() - startedAt,
        restoreMs: 0,
        restoreMode: this.restoreMode,
        chunks: chunks.length,
        targetRestored: false,
      };
    }
  }

  async _deliverByPaste(text, { onProgress, keepTextOnClipboard = false, targetContext } = {}) {
    let clipboardSnapshot = null;
    const finalText = String(text || "");
    const startedAt = Date.now();
    let pasteMs = 0;
    let restoreMs = 0;
    const chunks = this._splitTextForPaste(finalText, this.pasteChunkChars);

    const restoreClipboard = async () => {
      if (!clipboardSnapshot || this.restoreMode === "off") {
        return;
      }

      const restoreStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, this.restoreDelayMs));
      try {
        this.clipboard.clear();
        clipboardSnapshot.forEach(({ format, data }) => {
          this.clipboard.writeBuffer(format, data);
        });
      } catch (restoreError) {
        this.logger.warn("Failed to restore clipboard:", restoreError);
      } finally {
        restoreMs = Date.now() - restoreStartedAt;
      }
    };

    try {
      if (this.restoreMode !== "off" && !keepTextOnClipboard) {
        clipboardSnapshot = this._captureClipboardSnapshot();
      }

      for (let i = 0; i < chunks.length; i += 1) {
        this.clipboard.writeText(chunks[i]);
        if (typeof onProgress === "function") {
          onProgress({ index: i + 1, total: chunks.length, chars: chunks[i].length });
        }
        await this._sendPasteShortcut(targetContext);
        if (chunks.length > 1 && i < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, this.pasteChunkDelayMs));
        }
      }
      pasteMs = Date.now() - startedAt;

      if (keepTextOnClipboard) {
        this.clipboard.writeText(finalText);
      } else if (this.restoreMode === "off") {
        this.clipboard.writeText(finalText);
      } else if (this.restoreMode === "blocking") {
        await restoreClipboard();
      } else if (this.restoreMode === "deferred") {
        setTimeout(() => {
          restoreClipboard().catch((restoreError) => {
            this.logger.warn("Deferred clipboard restore failed:", restoreError);
          });
        }, 0);
      }

      return {
        ok: true,
        outputMode: "paste",
        pasteMs,
        restoreMs,
        restoreMode: this.restoreMode,
        chunks: chunks.length,
        targetRestored: Boolean(targetContext?.available),
      };
    } catch (error) {
      if (keepTextOnClipboard || this.restoreMode === "off") {
        try {
          this.clipboard.writeText(finalText);
        } catch (clipboardError) {
          this.logger.warn("Failed to keep text on clipboard after paste error:", clipboardError);
        }
      } else if (clipboardSnapshot) {
        await restoreClipboard();
      }
      this.logger.error("Error simulating typing:", error);
      return {
        ok: false,
        outputMode: "paste",
        error: error?.message || "Paste failed",
        pasteMs,
        restoreMs,
        restoreMode: this.restoreMode,
        chunks: chunks.length,
        targetRestored: false,
      };
    }
  }

  _captureClipboardSnapshot() {
    return this.clipboard.availableFormats().map((format) => ({
      format,
      data: this.clipboard.readBuffer(format),
    }));
  }

  // The default keeps the existing paste path, which on macOS clicks the Edit >
  // Paste menu item rather than sending Cmd+V because some apps ignore the
  // keystroke. Only a customised shortcut takes the generic keystroke route.
  _isDefaultPasteShortcut() {
    return String(this.pasteShortcut || "").replace(/\s+/g, "").toLowerCase() ===
      "commandorcontrol+v";
  }

  async _sendText(text, targetContext) {
    if (targetContext !== undefined && this.targetContextService) {
      return this.targetContextService.sendText(targetContext, text);
    }
    if (this.platform === "darwin") {
      await this.execFileAsync("osascript", [
        "-e",
        `tell application "System Events" to keystroke "${escapeAppleScriptText(text)}"`,
      ]);
    } else if (this.platform === "win32") {
      const keys = escapePowerShellSingleQuoted(escapeSendKeysText(text));
      await this.execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('${keys}')`,
      ]);
    } else {
      try {
        // `--` stops xdotool reading dictated text beginning with a dash as flags.
        await this.execFileAsync("xdotool", ["type", "--clearmodifiers", "--", text]);
      } catch (error) {
        const wrapped = new Error("Linux text insertion requires xdotool. Install it and try again.");
        wrapped.cause = error;
        throw wrapped;
      }
    }
  }

  async _sendCustomShortcut(targetContext) {
    if (targetContext !== undefined && this.targetContextService) {
      return this.targetContextService.sendKeystroke(targetContext, this.pasteShortcut);
    }
    if (this.platform === "darwin") {
      await this.execFileAsync("osascript", [
        "-e",
        `tell application "System Events" to ${toAppleScript(this.pasteShortcut, this.platform)}`,
      ]);
    } else if (this.platform === "win32") {
      const keys = escapePowerShellSingleQuoted(toSendKeys(this.pasteShortcut, this.platform));
      await this.execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('${keys}')`,
      ]);
    } else {
      await this._sendLinuxShortcut(toXdotool(this.pasteShortcut, this.platform));
    }
  }

  async _sendPasteShortcut(targetContext) {
    if (!this._isDefaultPasteShortcut()) {
      return this._sendCustomShortcut(targetContext);
    }
    if (targetContext !== undefined && this.targetContextService) {
      return this.targetContextService.sendPaste(targetContext);
    }
    if (this.platform === "darwin") {
      await this.execFileAsync("osascript", [
        "-e",
        MAC_PASTE_MENU_SCRIPT,
      ]);
    } else if (this.platform === "win32") {
      await this.execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('^v')",
      ]);
    } else {
      await this._sendLinuxShortcut("ctrl+v");
    }
  }

  async _sendLinuxShortcut(shortcut) {
    try {
      await this.execFileAsync("xdotool", ["key", "--clearmodifiers", shortcut]);
    } catch (error) {
      const wrapped = new Error(
        "Linux text insertion requires xdotool. Install it and try again."
      );
      wrapped.cause = error;
      throw wrapped;
    }
  }

  _splitTextForPaste(text, maxChars) {
    const value = String(text || "");
    if (!value) return [""];
    if (value.length <= maxChars) return [value];

    const chunks = [];
    let offset = 0;

    while (offset < value.length) {
      const remaining = value.length - offset;
      if (remaining <= maxChars) {
        chunks.push(value.slice(offset));
        break;
      }

      const hardEnd = offset + maxChars;
      const window = value.slice(offset, hardEnd);
      const breakIndex = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf("? "),
        window.lastIndexOf("! "),
        window.lastIndexOf(" ")
      );

      const splitAt = breakIndex >= Math.floor(maxChars * 0.5)
        ? offset + breakIndex + 1
        : hardEnd;
      chunks.push(value.slice(offset, splitAt));
      offset = splitAt;
    }

    return chunks;
  }

  async captureSelectedText({ targetContext } = {}) {
    let clipboardSnapshot = null;

    try {
      clipboardSnapshot = this._captureClipboardSnapshot();

      this.clipboard.clear();
      if (targetContext !== undefined && this.targetContextService) {
        await this.targetContextService.sendCopy(targetContext);
      } else if (this.platform === "darwin") {
        await this.execFileAsync("osascript", [
          "-e",
          'tell application "System Events" to keystroke "c" using command down',
        ]);
      } else if (this.platform === "win32") {
        await this.execFileAsync("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('^c')",
        ]);
      } else {
        await this._sendLinuxShortcut("ctrl+c");
      }

      await new Promise((resolve) => setTimeout(resolve, 80));
      const text = this.clipboard.readText() || "";
      return {
        ok: true,
        text,
        chars: text.length,
      };
    } catch (error) {
      this.logger.warn("Failed to capture selected text:", error);
      return {
        ok: false,
        text: "",
        chars: 0,
        error: error.message,
      };
    } finally {
      if (clipboardSnapshot && this.restoreMode !== "off") {
        try {
          this.clipboard.clear();
          clipboardSnapshot.forEach(({ format, data }) => {
            this.clipboard.writeBuffer(format, data);
          });
        } catch (restoreError) {
          this.logger.warn("Failed to restore clipboard after copy:", restoreError);
        }
      }
    }
  }
}

module.exports = {
  TypingService,
  MAC_PASTE_MENU_SCRIPT,
};
