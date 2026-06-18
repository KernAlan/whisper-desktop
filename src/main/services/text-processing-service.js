const Groq = require("groq-sdk");

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

class TextProcessingService {
  constructor({ apiKey, model, timeoutMs, dictionaryService, logger }) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.dictionaryService = dictionaryService;
    this.logger = logger || console;
    this.groq = new Groq({ apiKey });
  }

  setModel(model) {
    if (typeof model === "string" && model.trim()) {
      this.model = model.trim();
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
}

module.exports = {
  TextProcessingService,
};
