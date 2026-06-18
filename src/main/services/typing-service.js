const { clipboard } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const ks = require("node-key-sender");
const execFileAsync = promisify(execFile);

class TypingService {
  constructor({ logger, restoreMode = "deferred", restoreDelayMs = 120 }) {
    this.logger = logger || console;
    this.restoreMode = restoreMode;
    this.restoreDelayMs = restoreDelayMs;
  }

  setRestoreConfig({ restoreMode, restoreDelayMs }) {
    if (restoreMode) this.restoreMode = restoreMode;
    if (Number.isFinite(restoreDelayMs) && restoreDelayMs > 0) {
      this.restoreDelayMs = restoreDelayMs;
    }
  }

  async pasteText(text) {
    let clipboardSnapshot = null;
    const startedAt = Date.now();
    let pasteMs = 0;
    let restoreMs = 0;

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
      if (this.restoreMode !== "off") {
        clipboardSnapshot = clipboard.availableFormats().map((format) => ({
          format,
          data: clipboard.readBuffer(format),
        }));
      }

      clipboard.writeText(text);
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
      pasteMs = Date.now() - startedAt;

      if (this.restoreMode === "blocking") {
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
      };
    } catch (error) {
      this.logger.error("Error simulating typing:", error);
      return {
        ok: false,
        pasteMs,
        restoreMs,
        restoreMode: this.restoreMode,
      };
    }
  }

  async captureSelectedText() {
    let clipboardSnapshot = null;

    try {
      clipboardSnapshot = clipboard.availableFormats().map((format) => ({
        format,
        data: clipboard.readBuffer(format),
      }));

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
      return clipboard.readText() || "";
    } catch (error) {
      this.logger.warn("Failed to capture selected text:", error);
      return "";
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
