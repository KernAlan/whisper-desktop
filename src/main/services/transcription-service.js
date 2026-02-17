const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const Groq = require("groq-sdk");

const MAX_RECOVERY_FILES = 10;

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
    recoveryDir,
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
    this.recoveryDir = recoveryDir || path.join(os.tmpdir(), "whisper-desktop-recovery");
  }

  setModels({ model, fallbackModel }) {
    if (typeof model === "string" && model.trim()) {
      this.model = model.trim();
    }
    if (typeof fallbackModel === "string" && fallbackModel.trim()) {
      this.fallbackModel = fallbackModel.trim();
    }
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

  async transcribeChunked(arrayBuffers) {
    const tempFiles = [];
    const results = [];

    try {
      for (const buf of arrayBuffers) {
        const tempFilePath = path.join(
          os.tmpdir(),
          `temp_audio_${Date.now()}_${Math.random().toString(36).slice(2)}.webm`
        );
        await fs.writeFile(tempFilePath, Buffer.from(buf));
        tempFiles.push(tempFilePath);
      }

      for (let i = 0; i < tempFiles.length; i++) {
        this.logger.log(`[Chunked] Transcribing chunk ${i + 1}/${tempFiles.length}`);
        const result = await this._transcribeOne(tempFiles[i]);
        results.push(result.text);
      }

      // Success — clean up all temp files
      for (const f of tempFiles) {
        await fs.unlink(f).catch(() => {});
      }

      return results.join(" ");
    } catch (error) {
      // Save ALL chunks to recovery on any failure
      this.logger.error("[Chunked] Transcription failed, saving chunks to recovery:", error.message);
      for (const f of tempFiles) {
        await this._saveToRecovery(f);
      }
      const partial = results.length ? results.join(" ") : "";
      throw Object.assign(error, { partialText: partial });
    }
  }

  async _transcribeOne(tempFilePath) {
    if (!this.apiKey) throw new Error("Missing GROQ_API_KEY in environment");

    let usedModel = this.model;
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
    return { text: text || "", model: usedModel };
  }

  async _saveToRecovery(tempFilePath) {
    try {
      await fs.ensureDir(this.recoveryDir);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const ext = path.extname(tempFilePath) || ".webm";
      const recoveryName = `recording-${timestamp}${ext}`;
      const recoveryPath = path.join(this.recoveryDir, recoveryName);
      await fs.move(tempFilePath, recoveryPath, { overwrite: true });
      this.logger.log(`[Recovery] Audio saved to ${recoveryPath}`);
      await this._pruneRecovery();
      return recoveryPath;
    } catch (err) {
      this.logger.error("[Recovery] Failed to save audio:", err.message);
      return null;
    }
  }

  async _pruneRecovery() {
    try {
      const files = await fs.readdir(this.recoveryDir);
      if (files.length <= MAX_RECOVERY_FILES) return;

      const entries = await Promise.all(
        files.map(async (name) => {
          const fullPath = path.join(this.recoveryDir, name);
          const stat = await fs.stat(fullPath).catch(() => null);
          return stat ? { name, fullPath, mtimeMs: stat.mtimeMs } : null;
        })
      );

      const sorted = entries.filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs);
      const toDelete = sorted.slice(0, sorted.length - MAX_RECOVERY_FILES);
      for (const entry of toDelete) {
        await fs.unlink(entry.fullPath).catch(() => {});
        this.logger.log(`[Recovery] Pruned old file: ${entry.name}`);
      }
    } catch (err) {
      this.logger.error("[Recovery] Prune error:", err.message);
    }
  }

  async listRecoveryFiles() {
    try {
      await fs.ensureDir(this.recoveryDir);
      const files = await fs.readdir(this.recoveryDir);
      const entries = await Promise.all(
        files.map(async (name) => {
          const fullPath = path.join(this.recoveryDir, name);
          const stat = await fs.stat(fullPath).catch(() => null);
          if (!stat) return null;
          return {
            name,
            fullPath,
            size: stat.size,
            modified: stat.mtime,
          };
        })
      );
      return entries.filter(Boolean).sort((a, b) => b.modified - a.modified);
    } catch {
      return [];
    }
  }

  async retryRecoveryFile(filename) {
    const fullPath = path.join(this.recoveryDir, filename);
    if (!(await fs.pathExists(fullPath))) {
      throw new Error(`Recovery file not found: ${filename}`);
    }

    const result = await this._transcribeOne(fullPath);
    // Success — remove the recovery file
    await fs.unlink(fullPath).catch(() => {});
    this.logger.log(`[Recovery] Successfully retried and removed: ${filename}`);
    return result.text;
  }

  async _drain() {
    if (this.active) return;
    const item = this.queue.shift();
    if (!item) return;

    this.active = true;
    const startedAt = Date.now();
    const queueDelay = startedAt - item.queuedAt;
    let tempFilePath = null;

    try {
      tempFilePath = path.join(
        os.tmpdir(),
        `temp_audio_${Date.now()}_${Math.random().toString(36).slice(2)}.webm`
      );

      await fs.writeFile(tempFilePath, Buffer.from(item.arrayBuffer));
      const result = await this._transcribeOne(tempFilePath);

      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `[Perf] transcribe queueDelay=${queueDelay}ms duration=${durationMs}ms model=${result.model}`
      );
      this.onMetric({
        queueDelayMs: queueDelay,
        durationMs,
        model: result.model,
      });
      item.resolve(result.text);

      // Success — delete temp file
      if (tempFilePath && (await fs.pathExists(tempFilePath))) {
        await fs.unlink(tempFilePath).catch((cleanupError) => {
          this.logger.warn("Failed to remove temp audio file:", cleanupError);
        });
      }
    } catch (error) {
      // Failure — save to recovery instead of deleting
      if (tempFilePath && (await fs.pathExists(tempFilePath))) {
        await this._saveToRecovery(tempFilePath);
      }
      item.reject(error);
    } finally {
      this.active = false;
      if (this.queue.length) {
        this._drain().catch((error) => this.logger.error("Queue drain failure:", error));
      }
    }
  }
}

module.exports = {
  TranscriptionService,
};
