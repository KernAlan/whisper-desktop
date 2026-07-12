const fs = require("fs");
const path = require("path");

const SAMPLE_RATE = 16000;
const DEFAULT_KEYWORD = "Hey Whisper";
const CLOSE_KEYWORD = "Stop Whisper";
const WAKE_MODE = "wake";
const CLOSE_MODE = "close";
const KEYWORD_FILE_BY_MODE = {
  [WAKE_MODE]: "keywords.txt",
  [CLOSE_MODE]: "close-keywords.txt",
};

class WakeWordService {
  constructor({ modelDir, logger, onDetected }) {
    this.modelDir = modelDir;
    this.logger = logger || console;
    this.onDetected = typeof onDetected === "function" ? onDetected : () => {};
    this.enabled = false;
    this.keywordSpotter = null;
    this.keywordSpotters = new Map();
    this.stream = null;
    this.mode = WAKE_MODE;
    this.lastError = "";
  }

  getStatus() {
    return {
      enabled: this.enabled,
      available: Boolean(this.keywordSpotter),
      keyword: this.mode === CLOSE_MODE ? CLOSE_KEYWORD : DEFAULT_KEYWORD,
      mode: this.mode,
      error: this.lastError,
    };
  }

  start({ mode = WAKE_MODE } = {}) {
    if (!Object.hasOwn(KEYWORD_FILE_BY_MODE, mode)) {
      throw new Error(`Unsupported wake detector mode: ${mode}`);
    }
    if (this.enabled && this.stream && this.mode === mode) return this.getStatus();
    if (this.enabled) this.stop();
    this.keywordSpotter = this._ensureKeywordSpotter(mode);
    this.stream = this.keywordSpotter.createStream();
    this.mode = mode;
    this.enabled = true;
    this.lastError = "";
    const keyword = mode === CLOSE_MODE ? CLOSE_KEYWORD : DEFAULT_KEYWORD;
    this.logger.log(`[Wake] Local ${mode === CLOSE_MODE ? "close phrase" : "wake phrase"} armed: ${keyword}`);
    return this.getStatus();
  }

  stop() {
    this.enabled = false;
    if (this.stream?.inputFinished) {
      try {
        this.stream.inputFinished();
      } catch (_error) {
        // The native stream can already be finished during app shutdown.
      }
    }
    this.stream = null;
    return this.getStatus();
  }

  processFrame(frame) {
    if (!this.enabled || !this.keywordSpotter || !this.stream) return false;
    const samples = frame instanceof Float32Array
      ? frame
      : frame?.buffer instanceof ArrayBuffer
        ? new Float32Array(frame.buffer, frame.byteOffset || 0, Math.floor((frame.byteLength || frame.buffer.byteLength) / 4))
        : null;
    if (!samples?.length) return false;

    try {
      this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      while (this.keywordSpotter.isReady(this.stream)) {
        this.keywordSpotter.decode(this.stream);
        const result = this.keywordSpotter.getResult(this.stream);
        if (result?.keyword) {
          this.keywordSpotter.reset(this.stream);
          this.stop();
          this.onDetected({
            keyword: this.mode === CLOSE_MODE ? CLOSE_KEYWORD : DEFAULT_KEYWORD,
            mode: this.mode,
            startTime: Number(result.start_time || 0),
          });
          return true;
        }
      }
    } catch (error) {
      this.lastError = error?.message || "Wake detector failed";
      this.logger.error(`[Wake] Detector stopped: ${this.lastError}`);
      this.stop();
    }
    return false;
  }

  _ensureKeywordSpotter(mode = WAKE_MODE) {
    if (this.keywordSpotters.has(mode)) return this.keywordSpotters.get(mode);
    if (mode === WAKE_MODE && this.keywordSpotter && this.keywordSpotters.size === 0) {
      this.keywordSpotters.set(mode, this.keywordSpotter);
      return this.keywordSpotter;
    }
    const requiredFiles = [
      "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
      "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      "tokens.txt",
    ];
    for (const file of requiredFiles) {
      if (!fs.existsSync(path.join(this.modelDir, file))) {
        throw new Error(`Wake model asset is missing: ${file}`);
      }
    }

    let sherpa;
    try {
      sherpa = require("sherpa-onnx-node");
    } catch (error) {
      throw new Error(`Local wake engine is unavailable: ${error?.message || error}`);
    }

    const keywordFile = path.join(this.modelDir, KEYWORD_FILE_BY_MODE[mode]);
    if (!fs.existsSync(keywordFile)) {
      throw new Error(`Wake model asset is missing: ${KEYWORD_FILE_BY_MODE[mode]}`);
    }

    const keywordSpotter = new sherpa.KeywordSpotter({
      featConfig: {
        sampleRate: SAMPLE_RATE,
        featureDim: 80,
      },
      modelConfig: {
        transducer: {
          encoder: path.join(this.modelDir, requiredFiles[0]),
          decoder: path.join(this.modelDir, requiredFiles[1]),
          joiner: path.join(this.modelDir, requiredFiles[2]),
        },
        tokens: path.join(this.modelDir, requiredFiles[3]),
        provider: "cpu",
        numThreads: 1,
        debug: 0,
      },
      maxActivePaths: 4,
      numTrailingBlanks: 1,
      keywordsScore: 2.0,
      keywordsThreshold: 0.2,
      keywordsFile: keywordFile,
    });
    this.keywordSpotters.set(mode, keywordSpotter);
    return keywordSpotter;
  }
}

module.exports = {
  WakeWordService,
  SAMPLE_RATE,
  DEFAULT_KEYWORD,
  CLOSE_KEYWORD,
  WAKE_MODE,
  CLOSE_MODE,
};
