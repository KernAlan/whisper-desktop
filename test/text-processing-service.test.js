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

test("polish guard ignores typographic apostrophes and hyphens", () => {
  const text = service();
  assert.equal(
    text._keepsContentWords(
      "here's the six-out rule for the well-known case",
      "\u201CHere\u2019s the six\u2011out rule for the well\u2010known case."
    ),
    true
  );
});

test("polish guard treats number words and digits as the same word", () => {
  const text = service();
  assert.equal(
    text._keepsContentWords(
      "can we do another like 10 of these just various",
      "Can we do another like ten of these, just various?"
    ),
    true
  );
});

test("polish guard allows collapsing a repeated phrase false start", () => {
  const text = service();
  assert.equal(
    text._keepsContentWords(
      "no we can't we can't have sam play all six things",
      "No, we can't have Sam play all six things."
    ),
    true
  );
});

test("polish guard allows joining and splitting a compound", () => {
  const text = service();
  assert.equal(
    text._keepsContentWords(
      "put that line up into some kind of sheet",
      "Put that lineup into some kind of sheet."
    ),
    true
  );
  assert.equal(
    text._keepsContentWords(
      "put that lineup into some kind of sheet",
      "Put that line up into some kind of sheet."
    ),
    true
  );
});

test("polish guard keeps discourse markers the prompt tells the model to keep", () => {
  const text = service();
  assert.equal(
    text._keepsContentWords(
      "yeah the six outs doesn't make a whole lot of sense to me truthfully honestly",
      "The six outs doesn't make a whole lot of sense to me."
    ),
    false
  );
});

test("polish guard gives long dictations a small drop budget and short ones none", () => {
  const text = service();
  const long = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
  const longMinusOne = long.split(" ").filter((_, i) => i !== 50).join(" ");
  assert.equal(text._keepsContentWords(long, longMinusOne), true);
  assert.equal(
    text._keepsContentWords("ship the preview window today", "Ship the window today."),
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
