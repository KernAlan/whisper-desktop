export function serializeError(error) {
  if (!error) {
    return {
      name: "Error",
      message: "Unknown error",
    };
  }

  const name = error.name || error.constructor?.name || "Error";
  const message = error.message || String(error);
  const details = { name, message };

  if (error.code !== undefined) details.code = error.code;
  if (error.constraint) details.constraint = error.constraint;
  if (typeof error.stack === "string") details.stack = error.stack;

  return details;
}

export function formatError(error) {
  const details = serializeError(error);
  const parts = [`${details.name}: ${details.message}`];

  if (details.code !== undefined) parts.push(`code=${details.code}`);
  if (details.constraint) parts.push(`constraint=${details.constraint}`);

  return parts.join(" ");
}

export function microphoneStatusForError(error) {
  const name = error?.name || "";
  const message = String(error?.message || "");

  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return "Microphone permission denied";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone found";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Microphone unavailable";
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "Microphone constraints failed";
  }
  if (/no audio input|no microphone/i.test(message)) {
    return "No microphone found";
  }

  return "Microphone initialization failed";
}

export function userMessageForFailure(error, fallback = "Something failed") {
  const message = String(error?.message || error || "");
  if (!message) return fallback;
  if (/queue is full/i.test(message)) return "Still processing. Try again in a moment.";
  if (/api key|GROQ_API_KEY/i.test(message)) return "API key missing or invalid";
  if (/timed out/i.test(message)) return "Request timed out";
  if (/rate limit|429/i.test(message)) return "Service is rate limited";
  if (/network|fetch|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(message)) return "Network issue";
  return message;
}
