// The detector fires on "Hey Whisper" / "Stop Whisper", but the microphone keeps
// recording through the phrase, so the transcriber hears it too and it lands in
// the pasted text: "Take all the items home. Stop whisper."
//
// The transcriber spells it however it heard it -- "Stop, whisper.", "Stop
// whispering.", "Stop Whisper." -- and a recording that ends mid-word truncates
// it, so match a family of spellings instead of the literal phrase.
//
// Only the edges are trimmed. "I told him to stop whispering" is a real sentence,
// and the phrase is only ever spoken before or after the dictation, so a match in
// the middle is the user's own words and stays.

// Longest alternatives first: the regex takes the first that matches.
const WHISPER = String.raw`whisper(?:ings|ing|ers|ed|er|s)?|whispe|whisp|whis`;
// "Stop, whisper" and "Stop. Whisper." both come back from the transcriber, and
// so does the run-together "Stopwhisper".
const GAP = String.raw`[\s,.-]*`;
const TRAILING = String.raw`[\s.,!?;:…"')\]]*`;

const OPENING_PHRASE = new RegExp(
  String.raw`^[\s"'([]*(?:hey|hi)${GAP}(?:${WHISPER})${TRAILING}`,
  "i"
);
const CLOSING_PHRASE = new RegExp(
  String.raw`[\s,;:-]*\bstop${GAP}(?:${WHISPER})${TRAILING}$`,
  "i"
);
// The recording is cut the moment the detector fires, which often clips the
// phrase mid-word. The transcriber then writes a bare "Stop.", or patches the
// half-heard audio into "Stop the whisper." / "Stopped whispering." This looser
// pattern is only safe when the detector has told us the phrase was spoken.
const CLOSING_PHRASE_REMNANT = new RegExp(
  String.raw`[\s,;:-]*\bstop(?:ped|ping|s)?(?:${GAP}(?:the|it|that))?(?:${GAP}(?:${WHISPER}))?${TRAILING}$`,
  "i"
);

function stripRepeats(text, phrase) {
  let current = text;
  let previous = null;
  while (current && current !== previous) {
    previous = current;
    current = current.replace(phrase, "").trim();
  }
  return current;
}

/**
 * Removes the wake and close phrases from a finished transcript. Repeats go too:
 * a phrase said twice, or heard twice, is still not dictation.
 *
 * Pass `closePhraseStop` when the close-phrase detector is what ended the
 * recording. That is a much stronger signal than the text alone -- the detector
 * only fires on the real phrase -- so a trailing remnant can be trimmed that
 * would be too risky to guess at from an ordinary hotkey-stopped dictation.
 */
export function stripWakePhrases(transcript, { closePhraseStop = false } = {}) {
  let text = typeof transcript === "string" ? transcript.trim() : "";
  if (!text) return "";

  text = stripRepeats(text, OPENING_PHRASE);
  const beforeClosePhrase = text;
  text = stripRepeats(text, CLOSING_PHRASE);

  // Only when the spelled-out phrase was not found. If it was, it is already
  // gone, and a "stop" still at the end is a word the user dictated: they said
  // "...tell them to stop. Stop Whisper." and only the second one was ours.
  if (closePhraseStop && text === beforeClosePhrase) {
    text = text.replace(CLOSING_PHRASE_REMNANT, "").trim();
  }

  return text;
}

export { OPENING_PHRASE, CLOSING_PHRASE, CLOSING_PHRASE_REMNANT };
