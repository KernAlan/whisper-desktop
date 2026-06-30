const { clipboard } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const ks = require("node-key-sender");
const execFileAsync = promisify(execFile);

class TypingService {
  constructor({
    logger,
    restoreMode = "deferred",
    restoreDelayMs = 120,
    pasteChunkChars = 1500,
    pasteChunkDelayMs = 80,
  }) {
    this.logger = logger || console;
    this.restoreMode = restoreMode;
    this.restoreDelayMs = restoreDelayMs;
    this.pasteChunkChars = pasteChunkChars;
    this.pasteChunkDelayMs = pasteChunkDelayMs;
  }

  setRestoreConfig({ restoreMode, restoreDelayMs }) {
    if (restoreMode) this.restoreMode = restoreMode;
    if (Number.isFinite(restoreDelayMs) && restoreDelayMs > 0) {
      this.restoreDelayMs = restoreDelayMs;
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

  async pasteText(text, { onProgress, keepTextOnClipboard = true } = {}) {
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
        clipboard.clear();
        clipboardSnapshot.forEach(({ format, data }) => {
          clipboard.writeBuffer(format, data);
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
        clipboard.writeText(chunks[i]);
        if (typeof onProgress === "function") {
          onProgress({ index: i + 1, total: chunks.length, chars: chunks[i].length });
        }
        await this._sendPasteShortcut();
        if (chunks.length > 1 && i < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, this.pasteChunkDelayMs));
        }
      }
      pasteMs = Date.now() - startedAt;

      if (keepTextOnClipboard) {
        clipboard.writeText(finalText);
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
        pasteMs,
        restoreMs,
        restoreMode: this.restoreMode,
        chunks: chunks.length,
      };
    } catch (error) {
      if (keepTextOnClipboard) {
        try {
          clipboard.writeText(finalText);
        } catch (clipboardError) {
          this.logger.warn("Failed to keep text on clipboard after paste error:", clipboardError);
        }
      }
      this.logger.error("Error simulating typing:", error);
      return {
        ok: false,
        error: error?.message || "Paste failed",
        pasteMs,
        restoreMs,
        restoreMode: this.restoreMode,
        chunks: chunks.length,
      };
    }
  }

  _captureClipboardSnapshot() {
    return clipboard.availableFormats().map((format) => ({
      format,
      data: clipboard.readBuffer(format),
    }));
  }

  async _sendPasteShortcut() {
    if (process.platform === "darwin") {
      await execFileAsync("osascript", [
        "-e",
        'tell application "System Events" to keystroke "v" using command down',
      ]);
    } else if (process.platform === "win32") {
      try {
        await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('^v')",
        ]);
      } catch (windowsPasteError) {
        this.logger.warn("Native Windows paste failed, falling back to node-key-sender:", windowsPasteError);
        await ks.sendCombination(["control", "v"]);
      }
    } else {
      await ks.sendCombination(["control", "v"]);
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

  async captureSelectedText() {
    let clipboardSnapshot = null;

    try {
      clipboardSnapshot = this._captureClipboardSnapshot();

      clipboard.clear();
      if (process.platform === "darwin") {
        await execFileAsync("osascript", [
          "-e",
          'tell application "System Events" to keystroke "c" using command down',
        ]);
      } else if (process.platform === "win32") {
        await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('^c')",
        ]);
      } else {
        await ks.sendCombination(["control", "c"]);
      }

      await new Promise((resolve) => setTimeout(resolve, 80));
      const text = clipboard.readText() || "";
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
          clipboard.clear();
          clipboardSnapshot.forEach(({ format, data }) => {
            clipboard.writeBuffer(format, data);
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
};
