const test = require("node:test");
const assert = require("node:assert/strict");
const { TypingService } = require("../src/main/services/typing-service");

function service() {
  return new TypingService({ logger: { warn() {}, error() {} } });
}

test("splitTextForPaste keeps short text as one chunk", () => {
  const typing = service();
  assert.deepEqual(typing._splitTextForPaste("hello world", 1500), ["hello world"]);
});

test("splitTextForPaste preserves text exactly across chunks", () => {
  const typing = service();
  const text = "First sentence. Second sentence is longer.\n\nThird paragraph keeps going.";
  const chunks = typing._splitTextForPaste(text, 28);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text);
});
