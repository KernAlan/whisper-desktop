const fs = require("fs-extra");
const path = require("path");

const DEFAULT_MAX_ENTRIES = 100;

function safeTimestamp(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().replace(/[:.]/g, "-");
}

class TranscriptStore {
  constructor({ dir, logger, maxEntries = DEFAULT_MAX_ENTRIES }) {
    this.dir = dir;
    this.logger = logger || console;
    this.maxEntries = maxEntries;
  }

  async save(entry) {
    const text = String(entry?.text || "").trim();
    if (!text) return null;

    await fs.ensureDir(this.dir);
    const timestamp = Number(entry.timestamp || Date.now());
    const mode = String(entry.mode || "dictation").replace(/[^a-z0-9_-]/gi, "-");
    const name = `transcript-${safeTimestamp(timestamp)}-${mode}.txt`;
    const fullPath = path.join(this.dir, name);
    await fs.writeFile(fullPath, text, "utf8");
    await this._prune();
    return {
      name,
      path: fullPath,
      timestamp,
      chars: text.length,
    };
  }

  async latest() {
    const entries = await this.list(1);
    if (!entries.length) return null;
    const entry = entries[0];
    return {
      ...entry,
      text: await fs.readFile(entry.path, "utf8"),
    };
  }

  async list(limit = 20) {
    await fs.ensureDir(this.dir);
    const names = await fs.readdir(this.dir).catch(() => []);
    const entries = [];
    for (const name of names.filter((value) => value.endsWith(".txt"))) {
      const fullPath = path.join(this.dir, name);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) continue;
      entries.push({
        name,
        path: fullPath,
        modified: stat.mtime,
        modifiedMs: stat.mtimeMs,
        size: stat.size,
      });
    }
    return entries
      .sort((a, b) => b.modifiedMs - a.modifiedMs)
      .slice(0, Math.max(1, limit));
  }

  async _prune() {
    const entries = await this.list(Number.MAX_SAFE_INTEGER);
    const stale = entries.slice(this.maxEntries);
    for (const entry of stale) {
      await fs.unlink(entry.path).catch((error) => {
        this.logger.warn?.(`[TranscriptStore] Failed to prune ${entry.name}: ${error.message}`);
      });
    }
  }
}

module.exports = {
  TranscriptStore,
};
