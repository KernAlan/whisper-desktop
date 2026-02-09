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

  printStartup({ logFilePath = "", appVersion = "" } = {}) {
    if (this.printed) return;
    this.printed = true;

    const innerWidth = 76;
    const line = (text = "") => `| ${text.padEnd(innerWidth - 2)}|`;
    const border = `+${"-".repeat(innerWidth)}+`;
    const fit = (text, width) => {
      const value = String(text ?? "");
      if (value.length <= width) return value.padEnd(width);
      if (width <= 3) return ".".repeat(width);
      return `${value.slice(0, width - 3)}...`;
    };
    const step = (label, value) => line(fit(`> ${label.padEnd(28, ".")} ${value}`, innerWidth - 2));
    const shortPath = (value) => {
      const text = String(value || "");
      if (text.length <= 34) return text;
      return `...${text.slice(-31)}`;
    };
    const logo = [
      " __        ___     _                          ____            _    _             ",
      " \\ \\      / / |__ (_)___ _ __   ___ _ __     |  _ \\  ___  ___| | _| |_ ___  _ __ ",
      "  \\ \\ /\\ / /| '_ \\| / __| '_ \\ / _ \\ '__|    | | | |/ _ \\/ __| |/ / __/ _ \\| '__|",
      "   \\ V  V / | | | | \\__ \\ |_) |  __/ |       | |_| |  __/\\__ \\   <| || (_) | |   ",
      "    \\_/\\_/  |_| |_|_|___/ .__/ \\___|_|       |____/ \\___||___/_|\\_\\\\__\\___/|_|   ",
      "                        |_|                                                        ",
    ];

    this.logger.log(border);
    logo.forEach((logoLine) => this.logger.log(line(fit(logoLine, innerWidth - 2))));
    this.logger.log(line(fit(`BOOT SEQUENCE // VERSION ${appVersion || "unknown"}`, innerWidth - 2)));
    this.logger.log(border);
    this.logger.log(step("Kernel", "ONLINE"));
    this.logger.log(step("Audio Pipeline", "ONLINE"));
    this.logger.log(step("Transcription Engine", "ONLINE"));
    this.logger.log(step("Input Hotkey", this.config.shortcut));
    this.logger.log(step("Model", this.config.transcription.model));
    this.logger.log(step("Fallback", this.config.transcription.fallbackModel));
    this.logger.log(step("Request Timeout", `${this.config.transcription.timeoutMs}ms`));
    this.logger.log(step("Queue Capacity", String(this.config.transcription.maxQueue)));
    const hasApiKey = Boolean(this.config.transcription.apiKey);
    this.logger.log(step("API Credential", hasApiKey ? "PRESENT" : "MISSING"));
    this.logger.log(step("Platform", `${process.platform} (${process.arch})`));
    this.logger.log(step("Runtime", `Node ${process.version} | Electron ${process.versions.electron}`));
    const fileValue = shortPath(logFilePath || "n/a");
    this.logger.log(step("Log Stream", fileValue));
    this.logger.log(border);
    this.logger.log(line("SYSTEM READY"));
    this.logger.log(border);
  }

  logRendererPayload(payload) {
    if (!payload || typeof payload !== "object") return;
    const type = payload.type || "unknown";
    if (type === "mic-selected") {
      const label = String(payload.label || "unknown")
        .replace(/\s+/g, " ")
        .slice(0, 64);
      const deviceId = String(payload.deviceId || "unknown").slice(0, 24);
      this.logger.log(
        `[AUDIO] mic=${label} id=${deviceId}`
      );
      return;
    }
    if (type === "mic-refresh") {
      this.logger.log(
        `[AUDIO] refresh=${payload.status || "unknown"} selected="${payload.label || "unknown"}"`
      );
      return;
    }
    if (type === "audio-devices") {
      const count = Number.isFinite(payload.count) ? payload.count : 0;
      const summary = Array.isArray(payload.devices)
        ? payload.devices
            .slice(0, 3)
            .map((item) => String(item).replace(/\s+/g, " ").slice(0, 30))
            .join(" | ")
        : "none";
      this.logger.log(`[AUDIO] inputs=${count} :: ${summary}`);
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
