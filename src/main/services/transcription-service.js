const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const Groq = require("groq-sdk");

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

class TranscriptionService {
  constructor({
    apiKey,
    model,
    fallbackModel,
    timeoutMs,
    maxQueue,
    logger,
    onMetric,
  }) {
    this.apiKey = apiKey;
    this.model = model;
    this.fallbackModel = fallbackModel;
    this.timeoutMs = timeoutMs;
    this.maxQueue = maxQueue;
    this.logger = logger || console;
    this.onMetric = typeof onMetric === "function" ? onMetric : () => {};
    this.groq = new Groq({ apiKey });
    this.active = false;
    this.queue = [];
  }

  async transcribe(arrayBuffer) {
    if (this.queue.length >= this.maxQueue) {
      throw new Error("Transcription queue is full. Please try again.");
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ arrayBuffer, resolve, reject, queuedAt: Date.now() });
      this._drain().catch((error) => {
        this.logger.error("Queue drain failure:", error);
      });
    });
  }

  async _drain() {
    if (this.active) return;
    const item = this.queue.shift();
    if (!item) return;

    this.active = true;
    const startedAt = Date.now();
    const queueDelay = startedAt - item.queuedAt;
    let tempFilePath = null;
    let usedModel = this.model;

    try {
      if (!this.apiKey) throw new Error("Missing GROQ_API_KEY in environment");

      tempFilePath = path.join(
        os.tmpdir(),
        `temp_audio_${Date.now()}_${Math.random().toString(36).slice(2)}.webm`
      );

      await fs.writeFile(tempFilePath, Buffer.from(item.arrayBuffer));
      const primaryStream = fs.createReadStream(tempFilePath);

      let response;
      try {
        response = await withTimeout(
          this.groq.audio.transcriptions.create({
            file: primaryStream,
            model: this.model,
            response_format: "text",
          }),
          this.timeoutMs,
          `Transcription timed out after ${this.timeoutMs}ms`
        );
      } catch (error) {
        const message = error?.message || "";
        const shouldFallback =
          this.model !== this.fallbackModel &&
          /(model|unsupported|not found|invalid)/i.test(message);
        if (!shouldFallback) throw error;

        usedModel = this.fallbackModel;
        const fallbackStream = fs.createReadStream(tempFilePath);
        response = await withTimeout(
          this.groq.audio.transcriptions.create({
            file: fallbackStream,
            model: this.fallbackModel,
            response_format: "text",
          }),
          this.timeoutMs,
          `Fallback transcription timed out after ${this.timeoutMs}ms`
        );
      }

      const text = typeof response === "string" ? response : response?.text;
      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `[Perf] transcribe queueDelay=${queueDelay}ms duration=${durationMs}ms model=${usedModel}`
      );
      this.onMetric({
        queueDelayMs: queueDelay,
        durationMs,
        model: usedModel,
      });
      item.resolve(text || "");
    } catch (error) {
      item.reject(error);
    } finally {
      this.active = false;
      if (tempFilePath && (await fs.pathExists(tempFilePath))) {
        await fs.unlink(tempFilePath).catch((cleanupError) => {
          this.logger.warn("Failed to remove temp audio file:", cleanupError);
        });
      }
      if (this.queue.length) {
        this._drain().catch((error) => this.logger.error("Queue drain failure:", error));
      }
    }
  }
}

module.exports = {
  TranscriptionService,
};
