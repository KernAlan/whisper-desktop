class DiagnosticsService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger || console;
    this.printed = false;
    this._readySummaryPrinted = false;
    this._bootStart = Date.now();
    this._micLabel = null;
    this._deviceCount = 0;
    this.pipelineSamples = [];
    this.transcribeSamples = [];
    this.preprocessSamples = [];
    this.pasteSamples = [];
    this.summaryEvery = 10;
    this.transcriptHistory = [];
    this._transcriptListener = null;
  }

  printStartup({ logFilePath = "", appVersion = "" } = {}) {
    if (this.printed) return;
    this.printed = true;

    const dim = (s) => `\x1b[2m${s}\x1b[0m`;
    const bold = (s) => `\x1b[1m${s}\x1b[0m`;
    const green = (s) => `\x1b[32m${s}\x1b[0m`;
    const red = (s) => `\x1b[31m${s}\x1b[0m`;
    const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

    const kv = (label, value) => `  ${dim(label.padEnd(18))} ${value}`;
    const shortPath = (value) => {
      const text = String(value || "");
      if (text.length <= 40) return text;
      return `...${text.slice(-37)}`;
    };

    const hasApiKey = Boolean(this.config.transcription.apiKey);

    this.logger.log("");
    this.logger.log(`  ${bold("Whisper Desktop")} ${dim(`v${appVersion || "?"}`)}`);
    this.logger.log("");
    this.logger.log(kv("Hotkey", cyan(this.config.shortcut)));
    this.logger.log(kv("Model", this.config.transcription.model));
    this.logger.log(kv("Fallback", this.config.transcription.fallbackModel));
    this.logger.log(kv("Timeout", `${this.config.transcription.timeoutMs}ms`));
    this.logger.log(kv("Queue", String(this.config.transcription.maxQueue)));
    this.logger.log(kv("API Key", hasApiKey ? green("ok") : red("MISSING")));
    this.logger.log(kv("Platform", `${process.platform} (${process.arch})`));
    this.logger.log(kv("Runtime", dim(`Node ${process.version} | Electron ${process.versions.electron}`)));
    this.logger.log(kv("Log", dim(shortPath(logFilePath || "n/a"))));
    this.logger.log("");
  }

  logRendererPayload(payload) {
    if (!payload || typeof payload !== "object") return;
    const type = payload.type || "unknown";
    if (type === "mic-selected") {
      this._micLabel = String(payload.label || "unknown").replace(/\s+/g, " ").slice(0, 64);
      this._tryPrintReadySummary();
      return;
    }
    if (type === "mic-refresh") {
      this.logger.log(
        `[AUDIO] refresh=${payload.status || "unknown"} selected="${payload.label || "unknown"}"`
      );
      return;
    }
    if (type === "audio-devices") {
      this._deviceCount = Number.isFinite(payload.count) ? payload.count : 0;
      this._tryPrintReadySummary();
      return;
    }
    if (type === "pipeline-latency") {
      this.logger.log(
        `[PERF] pipeline=${payload.totalMs}ms pre=${payload.preprocessMs || 0}ms tx=${payload.transcribeMs}ms paste=${payload.pasteMs || 0}ms restore=${payload.restoreMs || 0}ms mode=${payload.clipboardRestoreMode || "unknown"} bytes=${payload.bytes}`
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

      if (payload.transcript && typeof payload.transcript === "string") {
        const entry = {
          text: payload.transcript,
          timestamp: Date.now(),
          durationMs: payload.transcribeMs || 0,
          bytes: payload.bytes || 0,
          pasteOk: payload.pasteOk,
        };
        this.transcriptHistory.push(entry);
        if (this.transcriptHistory.length > 50) {
          this.transcriptHistory.shift();
        }
        const preview = payload.transcript.length > 80
          ? payload.transcript.slice(0, 77) + "..."
          : payload.transcript;
        this.logger.log(`[Transcript] (${payload.transcript.length} chars) ${preview}`);
        if (this._transcriptListener) {
          try { this._transcriptListener(entry); } catch (_) { /* ignore */ }
        }
      }

      this.maybePrintPerfSummary();
      return;
    }
    this.logger.log(`[Renderer] ${JSON.stringify(payload)}`);
  }

  _tryPrintReadySummary() {
    if (this._readySummaryPrinted) return;
    if (!this._micLabel) return;
    this._readySummaryPrinted = true;

    // Small delay to let audio-devices event arrive too
    setTimeout(() => this._printReadySummary(), 200);
  }

  _printReadySummary() {
    const bootMs = Date.now() - this._bootStart;
    const green = (s) => `\x1b[32m${s}\x1b[0m`;
    const dim = (s) => `\x1b[2m${s}\x1b[0m`;
    const bold = (s) => `\x1b[1m${s}\x1b[0m`;

    const micShort = this._micLabel.length > 40
      ? this._micLabel.slice(0, 37) + "..."
      : this._micLabel;

    const hasKey = Boolean(this.config.transcription.apiKey);

    const parts = [];
    parts.push(`${green("Ready.")} Booted in ~${bootMs}ms.`);
    if (this._deviceCount > 0) {
      parts.push(`Mic: ${micShort} ${dim(`(${this._deviceCount} available)`)}`);
    } else {
      parts.push(`Mic: ${micShort}`);
    }
    if (!hasKey) {
      parts.push(`\x1b[31mNo API key set — transcription will fail.\x1b[0m`);
    }
    parts.push(`Hit ${bold(this.config.shortcut)} to record, or type ${bold("help")} for commands.`);

    this.logger.log("");
    parts.forEach((p) => this.logger.log(`  ${p}`));
    this.logger.log("");
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

  getTranscriptHistory(n) {
    if (!n || n >= this.transcriptHistory.length) return this.transcriptHistory.slice();
    return this.transcriptHistory.slice(-n);
  }

  setTranscriptListener(fn) {
    this._transcriptListener = typeof fn === "function" ? fn : null;
  }

  maybePrintPerfSummary() {
    const total = Math.max(this.pipelineSamples.length, this.transcribeSamples.length);
    if (!total || total % this.summaryEvery !== 0) return;

    if (this.pipelineSamples.length) {
      const p50 = Math.round(this.percentile(this.pipelineSamples, 50));
      const p95 = Math.round(this.percentile(this.pipelineSamples, 95));
      this.logger.log(
        `[PERF] summary pipeline n=${this.pipelineSamples.length} p50=${p50}ms p95=${p95}ms`
      );
    }

    if (this.transcribeSamples.length) {
      const p50 = Math.round(this.percentile(this.transcribeSamples, 50));
      const p95 = Math.round(this.percentile(this.transcribeSamples, 95));
      this.logger.log(
        `[PERF] summary transcribe n=${this.transcribeSamples.length} p50=${p50}ms p95=${p95}ms`
      );
    }

    if (this.preprocessSamples.length) {
      const p50 = Math.round(this.percentile(this.preprocessSamples, 50));
      const p95 = Math.round(this.percentile(this.preprocessSamples, 95));
      this.logger.log(
        `[PERF] summary preprocess n=${this.preprocessSamples.length} p50=${p50}ms p95=${p95}ms`
      );
    }

    if (this.pasteSamples.length) {
      const p50 = Math.round(this.percentile(this.pasteSamples, 50));
      const p95 = Math.round(this.percentile(this.pasteSamples, 95));
      this.logger.log(
        `[PERF] summary paste n=${this.pasteSamples.length} p50=${p50}ms p95=${p95}ms`
      );
    }
  }
}

module.exports = {
  DiagnosticsService,
};
