const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TextProcessingService,
  reasoningOptions,
} = require("../src/main/services/text-processing-service");

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

test("polish guard allows dropping standalone 'you know'", () => {
  const text = service();
  assert.equal(
    text._keepsContentWords(
      "I want to write a blog post about agent memory you know the part where the store wins",
      "I want to write a blog post about agent memory, the part where the store wins."
    ),
    true
  );
});

test("polish guard allows collapsing repeated stutters", () => {
  const text = service();
  assert.equal(
    text._keepsContentWords(
      "can you grab milk and also the the big bag of oats",
      "Can you grab milk, and also the big bag of oats?"
    ),
    true
  );
});

test("polish guard allows dropping a leading discourse marker", () => {
  const text = service();
  assert.equal(
    text._keepsContentWords(
      "so I think we should ship the fix today",
      "I think we should ship the fix today."
    ),
    true
  );
});

test("polish guard still rejects a dropped mid-sentence 'so'", () => {
  const text = service();
  assert.equal(
    text._keepsContentWords(
      "the build was broken so I reverted the change",
      "The build was broken. I reverted the change."
    ),
    false
  );
});

test("polish guard rejects a summarized rewrite", () => {
  const text = service();
  assert.equal(
    text._keepsContentWords(
      "um so the meeting on tuesday went well we talked about the budget and the launch date",
      "The Tuesday meeting went well."
    ),
    false
  );
});

test("reasoning options only apply to reasoning models", () => {
  assert.deepEqual(reasoningOptions("openai/gpt-oss-20b"), {
    reasoning_effort: "low",
    reasoning_format: "hidden",
  });
  assert.deepEqual(reasoningOptions("llama-3.3-70b-versatile"), {});
  assert.deepEqual(reasoningOptions(""), {});
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
