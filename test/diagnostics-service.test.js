const test = require("node:test");
const assert = require("node:assert/strict");
const { DiagnosticsService } = require("../src/main/services/diagnostics-service");

function config() {
  return {
    shortcut: "Ctrl+Shift+Space",
    transcription: {
      apiKey: "",
      model: "test-model",
      fallbackModel: "fallback-model",
      timeoutMs: 5000,
      maxQueue: 2,
    },
  };
}

test("DiagnosticsService never writes transcript or command contents to logs", () => {
  const lines = [];
  const diagnostics = new DiagnosticsService(config(), {
    log: (line) => lines.push(String(line)),
    warn: (line) => lines.push(String(line)),
  });

  diagnostics.logRendererPayload({
    type: "pipeline-latency",
    totalMs: 100,
    transcribeMs: 50,
    outputText: "private transcript contents",
    commandInstruction: "private command contents",
    commandSelectedChars: 10,
    commandOutputChars: 20,
  });

  const output = lines.join("\n");
  assert.equal(output.includes("private transcript contents"), false);
  assert.equal(output.includes("private command contents"), false);
  assert.match(output, /27 chars saved locally/);
  assert.match(output, /instructionChars=24/);
});

test("DiagnosticsService accepts an effective secure credential state", () => {
  const diagnostics = new DiagnosticsService(config(), { log() {}, warn() {} });
  assert.equal(diagnostics.apiKeyConfigured, false);
  diagnostics.setApiKeyConfigured(true);
  assert.equal(diagnostics.apiKeyConfigured, true);
});
