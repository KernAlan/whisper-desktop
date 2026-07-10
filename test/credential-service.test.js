const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("node:os");
const path = require("node:path");
const { CredentialService } = require("../src/main/services/credential-service");

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, ""),
  };
}

test("CredentialService encrypts, loads, and clears an API key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-credentials-"));
  const filePath = path.join(dir, "credentials.json");
  const service = new CredentialService({
    filePath,
    safeStorage: fakeSafeStorage(),
    logger: { warn() {} },
  });

  const apiKey = "gsk_test_key_that_is_long_enough";
  service.saveApiKey(apiKey);

  assert.equal(service.loadApiKey(), apiKey);
  assert.equal(fs.readFileSync(filePath, "utf8").includes(apiKey), false);

  service.clearApiKey();
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(service.loadApiKey(), "");
});

test("CredentialService refuses to save without secure storage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-credentials-"));
  const service = new CredentialService({
    filePath: path.join(dir, "credentials.json"),
    safeStorage: fakeSafeStorage(false),
    logger: { warn() {} },
  });

  assert.throws(
    () => service.saveApiKey("gsk_test_key_that_is_long_enough"),
    /Secure credential storage is unavailable/
  );
});

test("CredentialService rejects empty and incomplete keys", () => {
  const service = new CredentialService({
    filePath: path.join(os.tmpdir(), "unused-credentials.json"),
    safeStorage: fakeSafeStorage(),
    logger: { warn() {} },
  });

  assert.throws(() => service.saveApiKey(""), /Enter a Groq API key/);
  assert.throws(() => service.saveApiKey("short"), /appears incomplete/);
});
