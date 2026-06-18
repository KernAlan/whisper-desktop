const fs = require("fs-extra");

class DictionaryService {
  constructor({ filePath, logger }) {
    this.filePath = filePath;
    this.logger = logger || console;
    this.terms = [];
  }

  async load() {
    try {
      if (!(await fs.pathExists(this.filePath))) {
        await fs.ensureFile(this.filePath);
        await fs.writeJson(this.filePath, { terms: [] }, { spaces: 2 });
      }
      const data = await fs.readJson(this.filePath);
      this.terms = this._normalizeTerms(data?.terms || []);
    } catch (error) {
      this.logger.warn("[Dictionary] Failed to load dictionary:", error.message);
      this.terms = [];
    }
    return this.list();
  }

  list() {
    return this.terms.slice();
  }

  async add(term) {
    const normalized = this._normalizeTerm(term);
    if (!normalized) throw new Error("Dictionary term cannot be empty.");
    const exists = this.terms.some((item) => item.toLowerCase() === normalized.toLowerCase());
    if (!exists) {
      this.terms.push(normalized);
      this.terms.sort((a, b) => a.localeCompare(b));
      await this.save();
    }
    return this.list();
  }

  async remove(term) {
    const normalized = this._normalizeTerm(term);
    const before = this.terms.length;
    this.terms = this.terms.filter((item) => item.toLowerCase() !== normalized.toLowerCase());
    if (this.terms.length === before) {
      throw new Error(`Dictionary term not found: ${term}`);
    }
    await this.save();
    return this.list();
  }

  async save() {
    await fs.ensureFile(this.filePath);
    await fs.writeJson(this.filePath, { terms: this.terms }, { spaces: 2 });
  }

  buildPrompt() {
    if (!this.terms.length) return "";
    return `Prefer these spellings for names, acronyms, and jargon: ${this.terms.join(", ")}.`;
  }

  _normalizeTerms(terms) {
    const seen = new Set();
    const normalized = [];
    for (const term of terms) {
      const value = this._normalizeTerm(term);
      const key = value.toLowerCase();
      if (value && !seen.has(key)) {
        seen.add(key);
        normalized.push(value);
      }
    }
    return normalized.sort((a, b) => a.localeCompare(b));
  }

  _normalizeTerm(term) {
    return String(term || "").replace(/\s+/g, " ").trim().slice(0, 100);
  }
}

module.exports = {
  DictionaryService,
};
