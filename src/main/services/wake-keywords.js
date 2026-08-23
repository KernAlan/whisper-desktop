const fs = require("fs");

const WORD_BOUNDARY = "▁";

/**
 * Reads a sherpa-onnx `tokens.txt` and returns the set of modeling units.
 */
function readTokenSet(tokensPath) {
  const tokens = new Set();
  for (const line of fs.readFileSync(tokensPath, "utf8").split(/\r?\n/)) {
    const token = line.split(" ")[0];
    if (token) tokens.add(token);
  }
  return tokens;
}

/**
 * Converts a plain wake phrase into the BPE token sequence the keyword spotter
 * expects, using greedy longest-match against the model vocabulary.
 *
 * Both `▁S T O P` and `▁ST O P` are made of valid tokens, but only the greedy
 * segmentation matches what the transducer emits, so a hand-written keyword
 * file can look correct and still never fire. Derive it instead of typing it.
 */
function toKeywordTokens(phrase, tokens) {
  const pieces = [];
  for (const word of String(phrase).toUpperCase().split(/\s+/).filter(Boolean)) {
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let piece = null;
      for (; end > start; end -= 1) {
        const candidate = (start === 0 ? WORD_BOUNDARY : "") + word.slice(start, end);
        if (tokens.has(candidate)) {
          piece = candidate;
          break;
        }
      }
      if (!piece) {
        throw new Error(`Wake phrase "${phrase}" cannot be tokenized: no token matches "${word.slice(start)}"`);
      }
      pieces.push(piece);
      start = end;
    }
  }
  if (!pieces.length) throw new Error("Wake phrase is empty");
  return pieces.join(" ");
}

module.exports = { readTokenSet, toKeywordTokens, WORD_BOUNDARY };
