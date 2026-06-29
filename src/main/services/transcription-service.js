const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const Groq = require("groq-sdk");

const MAX_RECOVERY_SESSIONS = 10;
const PREVIEW_TIMEOUT_MS = 8000;
const PREVIEW_WARNING_THROTTLE_MS = 30000;

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
    dictionaryService,
    logger,
    onMetric,
    recoveryDir,
  }) {
    this.apiKey = apiKey;
    this.model = model;
    this.fallbackModel = fallbackModel;
    this.timeoutMs = timeoutMs;
    this.maxQueue = maxQueue;
    this.dictionaryService = dictionaryService;
    this.logger = logger || console;
    this.onMetric = typeof onMetric === "function" ? onMetric : () => {};
    this.groq = new Groq({ apiKey });
    this.active = false;
    this.previewActive = false;
    this.lastPreviewWarningAt = 0;
    this.lastPreviewWarningMessage = "";
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
    const sessionId = new Date().toISOString().replace(/[:.]/g, "-");

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
      const recoveryFiles = [];
      for (let i = 0; i < tempFiles.length; i += 1) {
        const recovery = await this._saveToRecovery(tempFiles[i], {
          sessionId,
          index: i,
          total: tempFiles.length,
        });
        if (recovery) recoveryFiles.push(recovery);
      }
      const partial = results.length ? results.join(" ") : "";
      throw Object.assign(error, { partialText: partial, recoveryFiles });
    }
  }

  async transcribePreview(arrayBuffer) {
    if (this.active || this.previewActive || this.queue.length > 0) {
      return { skipped: true, text: "" };
    }

    this.previewActive = true;
    const tempFilePath = path.join(
      os.tmpdir(),
      `preview_audio_${Date.now()}_${Math.random().toString(36).slice(2)}.webm`
    );

    try {
      await fs.writeFile(tempFilePath, Buffer.from(arrayBuffer));
      const result = await this._transcribeOne(tempFilePath, {
        timeoutMs: Math.min(this.timeoutMs, PREVIEW_TIMEOUT_MS),
      });
      return { skipped: false, text: result.text };
    } catch (error) {
      this._warnPreviewFailure(error);
      return {
        skipped: true,
        text: "",
        error: error?.message || "Preview transcription failed",
      };
    } finally {
      this.previewActive = false;
      await fs.unlink(tempFilePath).catch(() => {});
    }
  }

  async saveAudioBufferToRecovery(arrayBuffer) {
    const tempFilePath = path.join(
      os.tmpdir(),
      `recovery_audio_${Date.now()}_${Math.random().toString(36).slice(2)}.webm`
    );
    await fs.writeFile(tempFilePath, Buffer.from(arrayBuffer));
    return this._saveToRecovery(tempFilePath);
  }

  _warnPreviewFailure(error) {
    const message = error?.message || "Preview transcription failed";
    const now = Date.now();
    if (
      message === this.lastPreviewWarningMessage &&
      now - this.lastPreviewWarningAt < PREVIEW_WARNING_THROTTLE_MS
    ) {
      return;
    }
    this.lastPreviewWarningAt = now;
    this.lastPreviewWarningMessage = message;
    this.logger.warn(`[Preview] ${message}`);
  }

  async _transcribeOne(tempFilePath, options = {}) {
    if (!this.apiKey) throw new Error("Missing GROQ_API_KEY in environment");

    let usedModel = this.model;
    const primaryStream = fs.createReadStream(tempFilePath);
    const timeoutMs = Number(options.timeoutMs || this.timeoutMs);

    let response;
    try {
      response = await withTimeout(
        this.groq.audio.transcriptions.create({
          file: primaryStream,
          model: this.model,
          response_format: "text",
          prompt: this.dictionaryService?.buildPrompt?.() || undefined,
        }),
        timeoutMs,
        `Transcription timed out after ${timeoutMs}ms`
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
          prompt: this.dictionaryService?.buildPrompt?.() || undefined,
        }),
        timeoutMs,
        `Fallback transcription timed out after ${timeoutMs}ms`
      );
    }

    const text = typeof response === "string" ? response : response?.text;
    return { text: text || "", model: usedModel };
  }

  async _saveToRecovery(tempFilePath, options = {}) {
    try {
      await fs.ensureDir(this.recoveryDir);
      const timestamp = options.sessionId || new Date().toISOString().replace(/[:.]/g, "-");
      const ext = path.extname(tempFilePath) || ".webm";
      const total = Number(options.total || 1);
      const index = Number(options.index || 0);
      const recoveryName = total > 1
        ? `recording-${timestamp}-part-${String(index + 1).padStart(3, "0")}-of-${String(total).padStart(3, "0")}${ext}`
        : `recording-${timestamp}${ext}`;
      const recoveryPath = path.join(this.recoveryDir, recoveryName);
      await fs.move(tempFilePath, recoveryPath, { overwrite: true });
      this.logger.log(`[Recovery] Audio saved to ${recoveryPath}`);
      await this._pruneRecovery();
      return {
        name: recoveryName,
        path: recoveryPath,
        sessionId: timestamp,
        index,
        total,
      };
    } catch (err) {
      this.logger.error("[Recovery] Failed to save audio:", err.message);
      return null;
    }
  }

  async _pruneRecovery() {
    try {
      const files = await fs.readdir(this.recoveryDir);
      const entries = await Promise.all(
        files.map(async (name) => {
          const fullPath = path.join(this.recoveryDir, name);
          const stat = await fs.stat(fullPath).catch(() => null);
          return stat ? {
            name,
            fullPath,
            mtimeMs: stat.mtimeMs,
            ...this._parseRecoveryName(name),
          } : null;
        })
      );

      const groups = new Map();
      for (const entry of entries.filter(Boolean)) {
        const key = entry.sessionId || entry.name;
        const group = groups.get(key) || { key, entries: [], mtimeMs: 0 };
        group.entries.push(entry);
        group.mtimeMs = Math.max(group.mtimeMs, entry.mtimeMs);
        groups.set(key, group);
      }

      if (groups.size <= MAX_RECOVERY_SESSIONS) return;

      const sorted = Array.from(groups.values()).sort((a, b) => a.mtimeMs - b.mtimeMs);
      const toDelete = sorted.slice(0, sorted.length - MAX_RECOVERY_SESSIONS);
      for (const group of toDelete) {
        for (const entry of group.entries) {
          await fs.unlink(entry.fullPath).catch(() => {});
          this.logger.log(`[Recovery] Pruned old file: ${entry.name}`);
        }
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
            ...this._parseRecoveryName(name),
          };
        })
      );
      return entries.filter(Boolean).sort((a, b) => b.modified - a.modified);
    } catch {
      return [];
    }
  }

  async retryRecoveryFile(filename, { removeOnSuccess = true } = {}) {
    const entries = await this.listRecoveryFiles();
    let safeName = path.basename(filename);
    if (safeName.toLowerCase() === "latest") {
      if (!entries.length) throw new Error("No recovery files found.");
      safeName = entries[0].name;
    }
    const target = entries.find((entry) => entry.name === safeName);
    if (target?.total > 1 && target.sessionId) {
      return this.retryRecoverySession(target.sessionId, { removeOnSuccess });
    }
    if (!target && entries.some((entry) => entry.sessionId === safeName && entry.total > 1)) {
      return this.retryRecoverySession(safeName, { removeOnSuccess });
    }

    const fullPath = path.join(this.recoveryDir, safeName);
    if (!(await fs.pathExists(fullPath))) {
      throw new Error(`Recovery file not found: ${safeName}`);
    }

    const result = await this._transcribeOne(fullPath);
    if (removeOnSuccess) {
      await fs.unlink(fullPath).catch(() => {});
      this.logger.log(`[Recovery] Successfully retried and removed: ${safeName}`);
    } else {
      this.logger.log(`[Recovery] Successfully retried: ${safeName}`);
    }
    return result.text;
  }

  async retryRecoverySession(sessionId, { removeOnSuccess = true } = {}) {
    const entries = (await this.listRecoveryFiles())
      .filter((entry) => entry.sessionId === sessionId && entry.total > 1)
      .sort((a, b) => a.index - b.index);

    if (!entries.length) {
      throw new Error(`Recovery session not found: ${sessionId}`);
    }

    const expected = entries[0].total;
    if (entries.length < expected) {
      throw new Error(`Recovery session is missing chunks (${entries.length}/${expected})`);
    }

    const results = [];
    for (const entry of entries) {
      this.logger.log(`[Recovery] Retrying ${entry.name}`);
      const result = await this._transcribeOne(entry.fullPath);
      results.push(result.text);
    }

    if (removeOnSuccess) {
      for (const entry of entries) {
        await fs.unlink(entry.fullPath).catch(() => {});
      }
      this.logger.log(`[Recovery] Successfully retried and removed session ${sessionId}`);
    } else {
      this.logger.log(`[Recovery] Successfully retried session ${sessionId}`);
    }
    return results.join(" ");
  }

  async deleteRecoveryTarget(filename) {
    const entries = await this.listRecoveryFiles();
    let safeName = path.basename(filename || "latest");
    if (safeName.toLowerCase() === "latest") {
      if (!entries.length) return 0;
      safeName = entries[0].name;
    }

    const target = entries.find((entry) => entry.name === safeName);
    const sessionId = target?.total > 1 && target.sessionId
      ? target.sessionId
      : entries.some((entry) => entry.sessionId === safeName && entry.total > 1)
        ? safeName
        : "";

    const toDelete = sessionId
      ? entries.filter((entry) => entry.sessionId === sessionId)
      : target
        ? [target]
        : [];

    for (const entry of toDelete) {
      await fs.unlink(entry.fullPath).catch(() => {});
    }
    if (toDelete.length) {
      this.logger.log(`[Recovery] Deleted ${toDelete.length} recovered file(s) for ${safeName}`);
    }
    return toDelete.length;
  }

  _parseRecoveryName(name) {
    const chunk = /^recording-(.+)-part-(\d+)-of-(\d+)(\.[^.]+)$/i.exec(name);
    if (chunk) {
      return {
        sessionId: chunk[1],
        index: Math.max(0, Number(chunk[2]) - 1),
        total: Number(chunk[3]),
      };
    }

    return {
      sessionId: "",
      index: 0,
      total: 1,
    };
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
        const recovery = await this._saveToRecovery(tempFilePath);
        if (recovery) {
          error.recoveryFiles = [recovery];
        }
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
