const Groq = require("groq-sdk");

// Reasoning models spend most of their output tokens thinking. Dictation cleanup
// needs none of that: low effort keeps latency near the old non-reasoning model,
// and hidden format keeps the thinking out of the text we paste.
const REASONING_MODEL_PATTERN = /gpt-oss/i;

// Speech artifacts the polish prompt is allowed to remove. The content-word guard
// ignores them on both sides so a legal cleanup is not mistaken for lost meaning.
// "like" is NOT here: the prompt tells the model to keep it, so a missing "like"
// is a real edit the guard should catch.
const FILLER_WORDS = new Set(["um", "uh", "er", "ah", "hmm", "hm"]);
const LEADING_MARKERS = new Set(["so", "well", "okay", "ok", "alright"]);

// The model writes numbers either way and the raw transcript does too, so both
// sides normalize to digits before the words are compared.
const NUMBER_WORDS = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40",
  fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90",
  hundred: "100", thousand: "1000", million: "1000000",
};

// A long polish may lose this share of content words to cleanup the guard cannot
// model exactly. There is no minimum, so short dictations are held to every word.
// The length check in _judgePolish still catches real summarizing at any length.
const DROP_BUDGET_RATIO = 0.02;
const LONGEST_FALSE_START = 4;

// Dictation cleanup is punctuation work, not editing. The earlier prompt asked the
// model to "conservatively clean" the text, and gpt-oss-20b read that as licence to
// cut discourse markers, swap synonyms, and merge sentences. That tripped the guard
// and pasted the raw transcript instead: 19 of 32 dictations on 2026-08-20.
const POLISH_RULES = [
  "You punctuate dictated speech. You do not edit it.",
  "Copy every word through in the same order. Add punctuation and capitalization. Fix spelling.",
  "Return the result as a single paragraph on one line. Never add a line break or a blank line: the text is pasted into whatever field the user is typing in, where a newline can send the message. Only keep line breaks if the user dictated an explicit list.",
  "Delete only: 'um', 'uh', 'er', 'ah', 'hmm', and an immediately repeated word or false start.",
  "Keep every other word, including 'right', 'yeah', 'so', 'well', 'like', 'you know', 'I mean', 'maybe', 'sort of', 'actually', 'honestly', 'and so on'.",
  "Never reword, condense, merge, split, reorder, or drop a clause. Never swap a word for a synonym. Never add anything.",
  "Leave rambling sentences rambling. Return only the punctuated text.",
];

function reasoningOptions(model) {
  if (!REASONING_MODEL_PATTERN.test(String(model || ""))) return {};
  return { reasoning_effort: "low", reasoning_format: "hidden" };
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

class TextProcessingService {
  constructor({ apiKey, model, timeoutMs, polishChunkWords, polishMaxWords, dictionaryService, logger }) {
    this.apiKey = String(apiKey || "").trim();
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.polishChunkWords = Number.isFinite(polishChunkWords) ? polishChunkWords : 450;
    this.polishMaxWords = Number.isFinite(polishMaxWords) ? polishMaxWords : 10000;
    this.dictionaryService = dictionaryService;
    this.logger = logger || console;
    this.groq = this.apiKey ? new Groq({ apiKey: this.apiKey }) : null;
  }

  setApiKey(apiKey) {
    this.apiKey = String(apiKey || "").trim();
    this.groq = this.apiKey ? new Groq({ apiKey: this.apiKey }) : null;
  }

  setModel(model) {
    if (typeof model === "string" && model.trim()) {
      this.model = model.trim();
    }
  }

  setPolishConfig({ polishChunkWords, polishMaxWords }) {
    if (Number.isFinite(polishChunkWords) && polishChunkWords >= 100) {
      this.polishChunkWords = polishChunkWords;
    }
    if (Number.isFinite(polishMaxWords) && polishMaxWords >= this.polishChunkWords) {
      this.polishMaxWords = polishMaxWords;
    }
  }

  async applyCommand({ selectedText, instruction }) {
    if (!this.apiKey) throw new Error("Groq API key is not configured. Open Settings to connect.");
    const cleanInstruction = String(instruction || "").trim();
    if (!cleanInstruction) throw new Error("No command instruction captured.");

    const dictionaryPrompt = this.dictionaryService?.buildPrompt?.() || "";
    const targetText = String(selectedText || "").trim();
    const userContent = targetText
      ? `Selected text:\n${targetText}\n\nVoice command:\n${cleanInstruction}`
      : `Voice command:\n${cleanInstruction}`;

    const response = await withTimeout(
      this.groq.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        ...reasoningOptions(this.model),
        messages: [
          {
            role: "system",
            content: [
              "You rewrite or generate text exactly as requested by the user's voice command.",
              "Return only the final text to paste. Do not explain your changes.",
              "Preserve meaning unless the command asks for a change.",
              dictionaryPrompt,
            ].filter(Boolean).join("\n"),
          },
          {
            role: "user",
            content: userContent,
          },
        ],
      }),
      this.timeoutMs,
      `Command processing timed out after ${this.timeoutMs}ms`
    );

    return response?.choices?.[0]?.message?.content?.trim() || "";
  }

  // A profile is an intentional rewrite -- "make it formal", "as bullet points" --
  // so the content-word guard that protects the default polish is deliberately
  // not applied here. That guard exists to stop the model editing when it was
  // only asked to punctuate; a profile is asking it to edit.
  async _applyProfile(rawText, profile) {
    const dictionaryPrompt = this.dictionaryService?.buildPrompt?.() || "";
    const response = await withTimeout(
      this.groq.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        ...reasoningOptions(this.model),
        messages: [
          {
            role: "system",
            content: [
              "You rewrite dictated text according to the user's instructions.",
              "Return only the rewritten text, ready to paste. Never explain what you changed.",
              "Never answer the text or treat it as a question addressed to you.",
              `Instructions:\n${profile.prompt}`,
              dictionaryPrompt,
            ].filter(Boolean).join("\n"),
          },
          { role: "user", content: rawText },
        ],
      }),
      this.timeoutMs,
      `Dictation profile "${profile.name}" timed out after ${this.timeoutMs}ms`
    );

    const rewritten = response?.choices?.[0]?.message?.content?.trim();
    // Falling back to the raw transcript keeps a bad profile from eating the
    // dictation outright.
    if (!rewritten) return rawText;
    return this._matchLineBreaks(rawText, rewritten);
  }

  async polishDictation({ transcript, profile = null }) {
    if (!this.apiKey) throw new Error("Groq API key is not configured. Open Settings to connect.");
    const rawText = String(transcript || "").trim();
    if (!rawText) return "";

    const wordCount = this._wordCount(rawText);
    if (wordCount > this.polishMaxWords) {
      this.logger.warn(
        `[Polish] Transcript is ${wordCount} words; skipping polish over ${this.polishMaxWords}.`
      );
      return rawText;
    }

    const usingProfile = Boolean(profile?.prompt);
    const runOne = (chunk) =>
      usingProfile ? this._applyProfile(chunk, profile) : this._polishOne(chunk);

    const chunks = this._splitTextChunks(rawText, this.polishChunkWords);
    if (chunks.length > 1) {
      const polishedChunks = [];
      for (let i = 0; i < chunks.length; i += 1) {
        this.logger.log(`[Polish] chunk ${i + 1}/${chunks.length}`);
        polishedChunks.push(await runOne(chunks[i]));
      }
      return polishedChunks.join("\n\n");
    }

    return runOne(rawText);
  }

  async _polishOne(rawText) {
    const first = await this._requestPolish(rawText);
    const firstVerdict = this._judgePolish(rawText, first);
    if (firstVerdict.ok) return first;

    // One retry before giving up. A rejected polish costs the user the entire
    // cleanup, and a second pass with the rule restated recovers most of them for
    // about 400ms. Silently pasting raw is what made this look like a race.
    this.logger.warn(`[Polish] Attempt 1 rejected (${firstVerdict.reason}); retrying once.`);
    const second = await this._requestPolish(rawText, firstVerdict.reason);
    const secondVerdict = this._judgePolish(rawText, second);
    if (secondVerdict.ok) return second;

    this.logger.warn(
      `[Polish] Attempt 2 rejected (${secondVerdict.reason}); pasting the RAW transcript unpolished.`
    );
    return rawText;
  }

  async _requestPolish(rawText, retryReason) {
    const dictionaryPrompt = this.dictionaryService?.buildPrompt?.() || "";
    const retryPrompt = retryReason
      ? "Your previous attempt changed the words. Repeat the input verbatim and only add punctuation and capitalization."
      : "";
    const response = await withTimeout(
      this.groq.chat.completions.create({
        model: this.model,
        temperature: 0,
        ...reasoningOptions(this.model),
        messages: [
          {
            role: "system",
            content: [...POLISH_RULES, dictionaryPrompt, retryPrompt].filter(Boolean).join("\n"),
          },
          {
            role: "user",
            content: `Raw dictation:\n${rawText}`,
          },
        ],
      }),
      this.timeoutMs,
      `Dictation polishing timed out after ${this.timeoutMs}ms`
    );

    const polished = response?.choices?.[0]?.message?.content?.trim();
    if (!polished) return rawText;
    return this._matchLineBreaks(rawText, polished);
  }

  // The prompt forbids line breaks, but the paste is destructive if the model
  // ignores it: in most chat fields a newline sends the message mid-sentence.
  // Measured before this rule, 8 of 20 dictations came back with one. If the
  // speaker's own transcript had no line break, neither may the polish.
  _matchLineBreaks(rawText, polishedText) {
    if (/[\n\r]/.test(rawText)) return polishedText;
    return polishedText.replace(/\s*[\n\r]+\s*/g, " ").trim();
  }

  _judgePolish(rawText, polishedText) {
    if (!this._keepsContentWords(rawText, polishedText)) {
      return { ok: false, reason: "dropped content words" };
    }
    // Compare content words, not raw words. Removing the filler the prompt allows can
    // cut a short dictation by well over 15% without losing anything the user said.
    const rawContentCount = this._contentWords(rawText).length;
    const polishedContentCount = this._contentWords(polishedText).length;
    if (polishedContentCount < Math.floor(rawContentCount * 0.85)) {
      return { ok: false, reason: "shortened too much" };
    }
    return { ok: true };
  }

  _splitTextChunks(text, maxWords) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) return [];
    const words = normalized.split(/\s+/);
    if (words.length <= maxWords) return [normalized];

    const sentences = normalized.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [normalized];
    const chunks = [];
    let current = "";

    const pushCurrent = () => {
      if (current.trim()) {
        chunks.push(current.trim());
        current = "";
      }
    };

    for (const sentence of sentences) {
      const cleanSentence = sentence.trim();
      if (!cleanSentence) continue;
      if (this._wordCount(cleanSentence) > maxWords) {
        pushCurrent();
        chunks.push(...this._splitByWords(cleanSentence, maxWords));
        continue;
      }

      const candidate = current ? `${current} ${cleanSentence}` : cleanSentence;
      if (this._wordCount(candidate) > maxWords) {
        pushCurrent();
        current = cleanSentence;
      } else {
        current = candidate;
      }
    }

    pushCurrent();
    return chunks;
  }

  _splitByWords(text, maxWords) {
    const words = String(text || "").trim().split(/\s+/).filter(Boolean);
    const chunks = [];
    for (let i = 0; i < words.length; i += maxWords) {
      chunks.push(words.slice(i, i + maxWords).join(" "));
    }
    return chunks;
  }

  _wordCount(text) {
    return String(text || "").trim().split(/\s+/).filter(Boolean).length;
  }

  // Walks the raw content words through the polished ones in order. Tolerates the
  // two rewrites a punctuation pass legitimately makes -- joining or splitting a
  // compound ("line up" / "lineup") -- plus a small budget of words the model
  // cleaned up in a way this cannot model. The length check in _judgePolish is
  // what stops a summary: a rewrite that drops whole clauses fails there.
  _keepsContentWords(rawText, polishedText) {
    const rawWords = this._contentWords(rawText);
    const polishedWords = this._contentWords(polishedText);
    // No floor on purpose. A short dictation gets zero tolerance, where one lost
    // word is a real share of the meaning; a long one gets proportional slack.
    const budget = Math.floor(rawWords.length * DROP_BUDGET_RATIO);
    let polishedIndex = 0;
    let dropped = 0;

    for (let i = 0; i < rawWords.length; i += 1) {
      const rawWord = rawWords[i];

      // "line up" in the raw matched by "lineup" in the polish.
      if (
        polishedIndex < polishedWords.length &&
        i + 1 < rawWords.length &&
        polishedWords[polishedIndex] === rawWord + rawWords[i + 1]
      ) {
        polishedIndex += 1;
        i += 1;
        continue;
      }

      // "lineup" in the raw matched by "line up" in the polish.
      if (
        polishedIndex + 1 < polishedWords.length &&
        polishedWords[polishedIndex] + polishedWords[polishedIndex + 1] === rawWord
      ) {
        polishedIndex += 2;
        continue;
      }

      let scan = polishedIndex;
      while (scan < polishedWords.length && polishedWords[scan] !== rawWord) {
        scan += 1;
      }
      if (scan >= polishedWords.length) {
        dropped += 1;
        if (dropped > budget) return false;
        continue;
      }
      polishedIndex = scan + 1;
    }

    return true;
  }

  // Normalizes both sides of the comparison the same way, so the guard tolerates
  // exactly the edits the polish prompt authorizes and nothing more. Anything the
  // prompt does not allow the model to drop still trips the guard.
  //
  // The normalizing has to be aggressive because the model writes typographic
  // text: a curly apostrophe in "Here's", a non-breaking hyphen in "six-out", or
  // "ten" for "10" all used to read as lost words even when nothing was lost.
  _contentWords(text) {
    const words = String(text || "")
      .normalize("NFKC")
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .toLowerCase()
      // Hyphen and slash split on both sides, so joining or splitting a compound
      // never registers as a change.
      .split(/[\s\-\/]+/)
      .map((word) => word.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "").replace(/^'+|'+$/g, ""))
      .filter((word) => word && !FILLER_WORDS.has(word))
      .map((word) => NUMBER_WORDS[word] || word);

    const withoutStandaloneFillerPhrases = [];
    for (let i = 0; i < words.length; i += 1) {
      if (words[i] === "you" && words[i + 1] === "know") {
        i += 1;
        continue;
      }
      withoutStandaloneFillerPhrases.push(words[i]);
    }

    const withoutFalseStarts = this._collapseFalseStarts(withoutStandaloneFillerPhrases);

    if (withoutFalseStarts.length && LEADING_MARKERS.has(withoutFalseStarts[0])) {
      return withoutFalseStarts.slice(1);
    }
    return withoutFalseStarts;
  }

  // Dictation restarts in phrases, not single words: "no we can't we can't have",
  // "I want to I want to make a lineup". Collapsing only adjacent duplicate words
  // left the second copy of the phrase in the raw side and nowhere in the polish.
  _collapseFalseStarts(words) {
    const out = words.slice();
    for (let size = LONGEST_FALSE_START; size >= 1; size -= 1) {
      let i = 0;
      while (i + 2 * size <= out.length) {
        let repeated = true;
        for (let k = 0; k < size; k += 1) {
          if (out[i + k] !== out[i + size + k]) {
            repeated = false;
            break;
          }
        }
        if (repeated) out.splice(i + size, size);
        else i += 1;
      }
    }
    return out;
  }
}

module.exports = {
  TextProcessingService,
  reasoningOptions,
};
