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
      clipboardSnapshot = clipboard.availableFormats().map((format) => ({
        format,
        data: clipboard.readBuffer(format),
      }));

      clipboard.writeText(text);
      if (process.platform === "darwin") {
        await execFileAsync("osascript", [
          "-e",
          'tell application "System Events" to keystroke "v" using command down',
        ]);
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
}

module.exports = {
  TypingService,
};
