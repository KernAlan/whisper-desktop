const { maskApiKey } = require("../../shared/config");

class DiagnosticsService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger || console;
    this.printed = false;
    this.pipelineSamples = [];
    this.transcribeSamples = [];
    this.preprocessSamples = [];
    this.pasteSamples = [];
    this.summaryEvery = 10;
  }

  printStartup() {
    if (this.printed) return;
    this.printed = true;

    this.logger.log("=".repeat(60));
    this.logger.log("[Whisper Desktop] Startup Diagnostics");
    this.logger.log(`Platform: ${process.platform} (${process.arch})`);
    this.logger.log(`Node: ${process.version}`);
    this.logger.log(`Electron: ${process.versions.electron}`);
    this.logger.log(`Hotkey: ${this.config.shortcut}`);
    this.logger.log(`Transcription model: ${this.config.transcription.model}`);
    this.logger.log(`Fallback model: ${this.config.transcription.fallbackModel}`);
    this.logger.log(
      `Transcription timeout: ${this.config.transcription.timeoutMs}ms`
    );
    this.logger.log(`Max queue: ${this.config.transcription.maxQueue}`);
    this.logger.log(
      `GROQ_API_KEY: ${maskApiKey(this.config.transcription.apiKey)}`
    );
    this.logger.log("=".repeat(60));
  }

  logRendererPayload(payload) {
    if (!payload || typeof payload !== "object") return;
    const type = payload.type || "unknown";
    if (type === "mic-selected") {
      this.logger.log(
        `[Mic] selected="${payload.label || "unknown"}" id="${payload.deviceId || "unknown"}"`
      );
      return;
    }
    if (type === "mic-refresh") {
      this.logger.log(
        `[Mic] refresh status="${payload.status || "unknown"}" selected="${payload.label || "unknown"}"`
      );
      return;
    }
    if (type === "pipeline-latency") {
      this.logger.log(
        `[Perf] pipeline total=${payload.totalMs}ms preprocess=${payload.preprocessMs || 0}ms transcribe=${payload.transcribeMs}ms paste=${payload.pasteMs || 0}ms restore=${payload.restoreMs || 0}ms restoreMode=${payload.clipboardRestoreMode || "unknown"} bytes=${payload.bytes}`
      );
      if (Number.isFinite(payload.totalMs)) {
        this.pipelineSamples.push(Number(payload.totalMs));
      }
      if (Number.isFinite(payload.preprocessMs)) {
        this.preprocessSamples.push(Number(payload.preprocessMs));
      }
      if (Number.isFinite(payload.pasteMs)) {
        this.pasteSamples.push(Number(payload.pasteMs));
      }
      this.maybePrintPerfSummary();
      return;
    }
    this.logger.log(`[Renderer] ${JSON.stringify(payload)}`);
  }

  logTranscriptionMetric(metric) {
    if (!metric || !Number.isFinite(metric.durationMs)) return;
    this.transcribeSamples.push(Number(metric.durationMs));
    this.maybePrintPerfSummary();
  }

  percentile(values, p) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  }

  maybePrintPerfSummary() {
    const total = Math.max(this.pipelineSamples.length, this.transcribeSamples.length);
    if (!total || total % this.summaryEvery !== 0) return;

    if (this.pipelineSamples.length) {
      const p50 = Math.round(this.percentile(this.pipelineSamples, 50));
      const p95 = Math.round(this.percentile(this.pipelineSamples, 95));
      this.logger.log(
        `[PerfSummary] pipeline n=${this.pipelineSamples.length} p50=${p50}ms p95=${p95}ms`
      );
    }

    if (this.transcribeSamples.length) {
      const p50 = Math.round(this.percentile(this.transcribeSamples, 50));
      const p95 = Math.round(this.percentile(this.transcribeSamples, 95));
      this.logger.log(
        `[PerfSummary] transcribe n=${this.transcribeSamples.length} p50=${p50}ms p95=${p95}ms`
      );
    }

    if (this.preprocessSamples.length) {
      const p50 = Math.round(this.percentile(this.preprocessSamples, 50));
      const p95 = Math.round(this.percentile(this.preprocessSamples, 95));
      this.logger.log(
        `[PerfSummary] preprocess n=${this.preprocessSamples.length} p50=${p50}ms p95=${p95}ms`
      );
    }

    if (this.pasteSamples.length) {
      const p50 = Math.round(this.percentile(this.pasteSamples, 50));
      const p95 = Math.round(this.percentile(this.pasteSamples, 95));
      this.logger.log(
        `[PerfSummary] paste n=${this.pasteSamples.length} p50=${p50}ms p95=${p95}ms`
      );
    }
  }
}

module.exports = {
  DiagnosticsService,
};
