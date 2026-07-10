const fs = require("fs-extra");
const path = require("node:path");

class CredentialService {
  constructor({ filePath, safeStorage, logger }) {
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.logger = logger || console;
  }

  isEncryptionAvailable() {
    try {
      return Boolean(this.safeStorage?.isEncryptionAvailable?.());
    } catch {
      return false;
    }
  }

  loadApiKey() {
    try {
      if (!fs.existsSync(this.filePath)) return "";
      if (!this.isEncryptionAvailable()) {
        this.logger.warn?.("[Credentials] Secure storage is unavailable; saved key was not loaded.");
        return "";
      }

      const payload = fs.readJsonSync(this.filePath);
      if (payload?.version !== 1 || typeof payload.encryptedKey !== "string") {
        throw new Error("Unsupported credential file format");
      }
      return this.safeStorage.decryptString(Buffer.from(payload.encryptedKey, "base64")).trim();
    } catch (error) {
      this.logger.warn?.(`[Credentials] Failed to load saved key: ${error.message}`);
      return "";
    }
  }

  saveApiKey(value) {
    const apiKey = String(value || "").trim();
    if (!apiKey) throw new Error("Enter a Groq API key.");
    if (apiKey.length < 12) throw new Error("The Groq API key appears incomplete.");
    if (!this.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this system.");
    }

    const encryptedKey = this.safeStorage.encryptString(apiKey).toString("base64");
    fs.ensureDirSync(path.dirname(this.filePath));
    fs.writeJsonSync(this.filePath, { version: 1, encryptedKey }, {
      spaces: 2,
      mode: 0o600,
    });
    return apiKey;
  }

  clearApiKey() {
    fs.removeSync(this.filePath);
  }
}

module.exports = {
  CredentialService,
};
