const fs = require("fs-extra");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function safeTimestamp(timestamp = Date.now()) {
  const value = Number(timestamp);
  return new Date(Number.isFinite(value) ? value : Date.now()).toISOString().replace(/[:.]/g, "-");
}

function cleanText(value) {
  return String(value || "").trim();
}

function safeTargetMetadata(value) {
  if (!value || typeof value !== "object") return null;
  const appName = String(value.appName || "").replace(/[\r\n\t]/g, " ").slice(0, 100);
  const platform = String(value.platform || "").slice(0, 16);
  if (!appName && !platform) return null;
  return { appName, platform };
}

class TranscriptStore {
  constructor({
    dir,
    logger,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxBytes = DEFAULT_MAX_BYTES,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
  }) {
    this.dir = dir;
    this.logger = logger || console;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.maxAgeMs = maxAgeMs;
    this.pendingUndoneIds = new Set();
  }

  async save(entry) {
    const text = cleanText(entry?.finalText || entry?.text);
    if (!text) return null;

    await fs.ensureDir(this.dir);
    const parsedTimestamp = Number(entry.timestamp);
    const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now();
    const mode = String(entry.mode || "dictation").replace(/[^a-z0-9_-]/gi, "-");
    const requestedId = String(entry.id || "").replace(/[^a-z0-9_-]/gi, "-").slice(0, 120);
    const id = requestedId || randomUUID();
    const name = `transcript-${safeTimestamp(timestamp)}-${mode}-${id.slice(0, 16)}.json`;
    const fullPath = path.join(this.dir, name);
    const record = {
      version: 1,
      id,
      timestamp,
      mode,
      rawText: cleanText(entry.rawText || text),
      finalText: text,
      target: safeTargetMetadata(entry.target),
      paste: {
        ok: entry.paste?.ok === true || entry.pasteOk === true,
        chunks: Number(entry.paste?.chunks ?? entry.pasteChunks ?? 0),
        pasteMs: Number(entry.paste?.pasteMs ?? entry.pasteMs ?? 0),
        restoreMs: Number(entry.paste?.restoreMs ?? entry.restoreMs ?? 0),
        targetRestored: entry.paste?.targetRestored === true || entry.targetRestored === true,
      },
      polished: entry.polished === true,
      undone: entry.undone === true || this.pendingUndoneIds.delete(id),
    };
    await fs.writeJson(fullPath, record, { spaces: 2, mode: 0o600 });
    await this.prune();
    return this._entryFromRecord(name, fullPath, await fs.stat(fullPath), record);
  }

  async latest() {
    const entries = await this.list(1);
    return entries[0] || null;
  }

  async list(limit = 20) {
    const entries = await this._readEntries();
    return entries.slice(0, Math.max(1, limit));
  }

  async markUndone(id) {
    const entry = (await this._readEntries()).find((item) => item.id === id && item.format === "transaction");
    if (!entry) {
      this.pendingUndoneIds.add(id);
      return { id, undone: true, pending: true };
    }
    const record = await fs.readJson(entry.path);
    record.undone = true;
    await fs.writeJson(entry.path, record, { spaces: 2, mode: 0o600 });
    return this._entryFromRecord(entry.name, entry.path, await fs.stat(entry.path), record);
  }

  async prune() {
    const entries = await this._readEntries();
    const now = Date.now();
    const newestId = entries[0]?.id;
    let keptCount = 0;
    let keptBytes = 0;

    for (const entry of entries) {
      const expired = this.maxAgeMs > 0 && now - entry.modifiedMs > this.maxAgeMs;
      const exceedsEntries = keptCount >= this.maxEntries;
      const exceedsBytes = keptBytes + entry.size > this.maxBytes;
      const mustKeepNewest = entry.id === newestId;
      if (!mustKeepNewest && (expired || exceedsEntries || exceedsBytes)) {
        await fs.unlink(entry.path).catch((error) => {
          this.logger.warn?.(`[TranscriptStore] Failed to prune ${entry.name}: ${error.message}`);
        });
        continue;
      }
      keptCount += 1;
      keptBytes += entry.size;
    }
  }

  async _readEntries() {
    await fs.ensureDir(this.dir);
    const names = await fs.readdir(this.dir).catch(() => []);
    const entries = [];
    for (const name of names.filter((value) => value.endsWith(".json") || value.endsWith(".txt"))) {
      const fullPath = path.join(this.dir, name);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) continue;
      try {
        if (name.endsWith(".json")) {
          const record = await fs.readJson(fullPath);
          if (record?.version !== 1 || !cleanText(record.finalText)) continue;
          entries.push(this._entryFromRecord(name, fullPath, stat, record));
        } else {
          const text = cleanText(await fs.readFile(fullPath, "utf8"));
          if (!text) continue;
          entries.push({
            id: path.basename(name, ".txt"),
            name,
            path: fullPath,
            format: "legacy",
            text,
            rawText: text,
            finalText: text,
            mode: "dictation",
            target: null,
            paste: { ok: null, chunks: 0, pasteMs: 0, restoreMs: 0, targetRestored: false },
            polished: false,
            undone: false,
            modified: stat.mtime,
            modifiedMs: stat.mtimeMs,
            size: stat.size,
          });
        }
      } catch (error) {
        this.logger.warn?.(`[TranscriptStore] Failed to read ${name}: ${error.message}`);
      }
    }
    return entries.sort((a, b) => b.modifiedMs - a.modifiedMs);
  }

  _entryFromRecord(name, fullPath, stat, record) {
    const finalText = cleanText(record.finalText);
    const parsedTimestamp = Number(record.timestamp);
    const modifiedMs = Number.isFinite(parsedTimestamp) ? parsedTimestamp : stat.mtimeMs;
    return {
      id: String(record.id || path.basename(name, ".json")),
      name,
      path: fullPath,
      format: "transaction",
      text: finalText,
      rawText: cleanText(record.rawText || finalText),
      finalText,
      mode: String(record.mode || "dictation"),
      target: safeTargetMetadata(record.target),
      paste: {
        ok: record.paste?.ok === true,
        chunks: Number(record.paste?.chunks || 0),
        pasteMs: Number(record.paste?.pasteMs || 0),
        restoreMs: Number(record.paste?.restoreMs || 0),
        targetRestored: record.paste?.targetRestored === true,
      },
      polished: record.polished === true,
      undone: record.undone === true,
      modified: new Date(modifiedMs),
      modifiedMs,
      size: stat.size,
    };
  }
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  TranscriptStore,
};
