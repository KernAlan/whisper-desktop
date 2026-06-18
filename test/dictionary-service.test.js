const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("fs-extra");
const { DictionaryService } = require("../src/main/services/dictionary-service");

test("DictionaryService normalizes, persists, and removes terms", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-dict-test-"));
  const filePath = path.join(dir, "dictionary.json");
  const service = new DictionaryService({ filePath, logger: { warn() {} } });

  await service.load();
  await service.add("  Kern Alan  ");
  await service.add("kern alan");
  await service.add("Groq");

  assert.deepEqual(service.list(), ["Groq", "Kern Alan"]);
  assert.match(service.buildPrompt(), /Kern Alan/);

  const reloaded = new DictionaryService({ filePath, logger: { warn() {} } });
  await reloaded.load();
  assert.deepEqual(reloaded.list(), ["Groq", "Kern Alan"]);

  await reloaded.remove("groq");
  assert.deepEqual(reloaded.list(), ["Kern Alan"]);

  await fs.remove(dir);
});
