const Groq = require("groq-sdk");

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

class TextProcessingService {
  constructor({ apiKey, model, timeoutMs, polishChunkWords, polishMaxWords, dictionaryService, logger }) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.polishChunkWords = Number.isFinite(polishChunkWords) ? polishChunkWords : 450;
    this.polishMaxWords = Number.isFinite(polishMaxWords) ? polishMaxWords : 2500;
    this.dictionaryService = dictionaryService;
    this.logger = logger || console;
    this.groq = new Groq({ apiKey });
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
    if (!this.apiKey) throw new Error("Missing GROQ_API_KEY in environment");
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

  async polishDictation({ transcript }) {
    if (!this.apiKey) throw new Error("Missing GROQ_API_KEY in environment");
    const rawText = String(transcript || "").trim();
    if (!rawText) return "";

    const wordCount = this._wordCount(rawText);
    if (wordCount > this.polishMaxWords) {
      this.logger.warn(
        `[Polish] Transcript is ${wordCount} words; skipping polish over ${this.polishMaxWords}.`
      );
      return rawText;
    }

    const chunks = this._splitTextChunks(rawText, this.polishChunkWords);
    if (chunks.length > 1) {
      const polishedChunks = [];
      for (let i = 0; i < chunks.length; i += 1) {
        this.logger.log(`[Polish] chunk ${i + 1}/${chunks.length}`);
        polishedChunks.push(await this._polishOne(chunks[i]));
      }
      return polishedChunks.join("\n\n");
    }

    return this._polishOne(rawText);
  }

  async _polishOne(rawText) {
    const dictionaryPrompt = this.dictionaryService?.buildPrompt?.() || "";
    const response = await withTimeout(
      this.groq.chat.completions.create({
        model: this.model,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: [
              "Conservatively clean dictated speech into readable text.",
              "Do not summarize, rewrite, shorten, or change what the user said.",
              "Never remove content words.",
              "You may remove only obvious filler words or speech artifacts such as 'um', 'uh', 'er', 'ah', repeated stutters, and standalone 'you know'.",
              "Only add punctuation, capitalization, line breaks, and list formatting when clearly implied.",
              "Do not add new facts, explanations, greetings, or commentary.",
              "Return only the final text to paste.",
              dictionaryPrompt,
            ].filter(Boolean).join("\n"),
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

    const polishedText = response?.choices?.[0]?.message?.content?.trim() || rawText;
    if (!this._keepsContentWords(rawText, polishedText)) {
      this.logger.warn("[Polish] Output dropped content words; using raw transcript.");
      return rawText;
    }
    if (this._wordCount(polishedText) < Math.floor(this._wordCount(rawText) * 0.85)) {
      this.logger.warn("[Polish] Output shortened too much; using raw transcript.");
      return rawText;
    }
    return polishedText;
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

  _keepsContentWords(rawText, polishedText) {
    const rawWords = this._contentWords(rawText);
    const polishedWords = this._contentWords(polishedText);
    let polishedIndex = 0;

    for (const rawWord of rawWords) {
      while (polishedIndex < polishedWords.length && polishedWords[polishedIndex] !== rawWord) {
        polishedIndex += 1;
      }
      if (polishedIndex >= polishedWords.length) {
        return false;
      }
      polishedIndex += 1;
    }

    return true;
  }

  _contentWords(text) {
    const allowedDrops = new Set([
      "um",
      "uh",
      "er",
      "ah",
      "hmm",
      "hm",
      "like",
    ]);

    return String(text || "")
      .toLowerCase()
      .split(/\s+/)
      .map((word) => word.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ""))
      .filter((word) => word && !allowedDrops.has(word));
  }
}

module.exports = {
  TextProcessingService,
};
