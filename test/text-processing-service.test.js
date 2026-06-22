const test = require("node:test");
const assert = require("node:assert/strict");
const { TextProcessingService } = require("../src/main/services/text-processing-service");

function service() {
  return new TextProcessingService({
    apiKey: "test",
    model: "test",
    timeoutMs: 1000,
    logger: { warn() {} },
  });
}

test("polish guard allows dropping filler words", () => {
  const text = service();
  assert.equal(
    text._keepsContentWords("um I think this is good", "I think this is good."),
    true
  );
});

test("polish guard rejects dropped content words", () => {
  const text = service();
  assert.equal(
    text._keepsContentWords(
      "I think we should ship the preview window today",
      "I think we should ship today."
    ),
    false
  );
});

test("split text chunks respects word limit", () => {
  const text = service();
  const chunks = text._splitTextChunks(
    "One two three four five. Six seven eight nine ten. Eleven twelve thirteen.",
    5
  );
  assert.deepEqual(chunks, [
    "One two three four five.",
    "Six seven eight nine ten.",
    "Eleven twelve thirteen.",
  ]);
});
