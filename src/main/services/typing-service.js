const { clipboard } = require("electron");
const ks = require("node-key-sender");

class TypingService {
  constructor({ logger, restoreMode = "deferred", restoreDelayMs = 120 }) {
    this.logger = logger || console;
    this.restoreMode = restoreMode;
    this.restoreDelayMs = restoreDelayMs;
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
      const modifier = process.platform === "darwin" ? "command" : "control";
      await ks.sendCombination([modifier, "v"]);
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
