const test = require("node:test");
const assert = require("node:assert/strict");

async function strip() {
  const { stripWakePhrases } = await import("../src/renderer/core/wake-phrase-text.js");
  return stripWakePhrases;
}

test("the close phrase is removed however the transcriber spelled it", async () => {
  const stripWakePhrases = await strip();
  for (const heard of [
    "Take all the items home. Stop whisper.",
    "Take all the items home. Stop, whisper.",
    "Take all the items home. Stop whispering.",
    "Take all the items home. Stop Whisper.",
    "Take all the items home. stop whisper",
    "Take all the items home. Stop. Whisper!",
  ]) {
    assert.equal(stripWakePhrases(heard), "Take all the items home.", heard);
  }
});

test("a recording that cut the close phrase short is still removed", async () => {
  const stripWakePhrases = await strip();
  assert.equal(stripWakePhrases("Take all the items home. Stop whis"), "Take all the items home.");
  assert.equal(stripWakePhrases("Take the items home, stop whisp"), "Take the items home");
});

test("both phrases go, and repeats of them", async () => {
  const stripWakePhrases = await strip();
  assert.equal(
    stripWakePhrases("Hey Whisper. Take all the items home. Stop Whisper."),
    "Take all the items home."
  );
  assert.equal(
    stripWakePhrases("Take all the items home. Stop whisper. Stop whisper."),
    "Take all the items home."
  );
});

// The phrase is only ever spoken around the dictation, so a match in the middle
// is the user talking about whispering.
test("the same words inside a sentence are left alone", async () => {
  const stripWakePhrases = await strip();
  for (const dictated of [
    "I told him to stop whispering in class today.",
    "Make it stop. Whispering is rude.",
    "The nonstop whisper of the fan.",
    "Tell the kids to stop.",
  ]) {
    assert.equal(stripWakePhrases(dictated), dictated);
  }
});

test("a transcript of nothing but the phrase comes back empty", async () => {
  const stripWakePhrases = await strip();
  assert.equal(stripWakePhrases("Stop whisper."), "");
  assert.equal(stripWakePhrases("Hey Whisper."), "");
  assert.equal(stripWakePhrases(""), "");
  assert.equal(stripWakePhrases(null), "");
});

// When the detector is what stopped the recording we know the phrase was spoken,
// so a mangled or clipped remnant can be trimmed on that evidence alone.
test("a clipped close phrase is removed when the detector fired", async () => {
  const stripWakePhrases = await strip();
  const detected = { closePhraseStop: true };
  for (const heard of [
    "Take all the items home. Stop.",
    "Take all the items home. Stop!",
    "Take all the items home. Stop the whisper.",
    "Take all the items home. Stopped whispering.",
    "Take all the items home. Stopping.",
  ]) {
    assert.equal(stripWakePhrases(heard, detected), "Take all the items home.", heard);
  }
});

test("a clipped close phrase is left alone when the hotkey stopped the recording", async () => {
  const stripWakePhrases = await strip();
  for (const dictated of [
    "Take all the items home. Stop.",
    "Take all the items home. Stop the whisper.",
  ]) {
    assert.equal(stripWakePhrases(dictated), dictated);
  }
});

// The user's own trailing "stop" survives: the phrase was found and removed
// already, so what is left is dictation.
test("only one close phrase is removed even when the detector fired", async () => {
  const stripWakePhrases = await strip();
  assert.equal(
    stripWakePhrases("Tell them to stop. Stop whisper.", { closePhraseStop: true }),
    "Tell them to stop."
  );
});
