const TARGET_SAMPLE_RATE = 16000;

class LinearResampler {
  constructor(sourceRate, targetRate = TARGET_SAMPLE_RATE) {
    this.sourceRate = sourceRate || targetRate;
    this.targetRate = targetRate;
    this.step = this.sourceRate / this.targetRate;
    this.buffer = new Float32Array(0);
    this.position = 0;
  }

  reset() {
    this.buffer = new Float32Array(0);
    this.position = 0;
  }

  push(samples) {
    if (!samples?.length) return new Float32Array(0);
    if (this.sourceRate === this.targetRate) return new Float32Array(samples);

    const combined = new Float32Array(this.buffer.length + samples.length);
    combined.set(this.buffer);
    combined.set(samples, this.buffer.length);
    this.buffer = combined;

    const output = [];
    while (this.position + 1 < this.buffer.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      output.push(
        this.buffer[left] * (1 - fraction) + this.buffer[left + 1] * fraction
      );
      this.position += this.step;
    }

    const consumed = Math.max(0, Math.floor(this.position));
    if (consumed) {
      this.buffer = this.buffer.slice(consumed);
      this.position -= consumed;
    }
    return Float32Array.from(output);
  }
}

export class WakeController {
  constructor({
    audioEngine,
    requestMicrophoneAccess,
    startWakeWord,
    stopWakeWord,
    sendWakeWordFrame,
    onWakeWord,
    onClosePhrase,
    onStatus,
    isRecorderBusy,
  }) {
    this.audioEngine = audioEngine;
    this.requestMicrophoneAccess = requestMicrophoneAccess;
    this.startWakeWord = startWakeWord;
    this.stopWakeWord = stopWakeWord;
    this.sendWakeWordFrame = sendWakeWordFrame;
    this.onWakeWord = typeof onWakeWord === "function" ? onWakeWord : async () => {};
    this.onClosePhrase = typeof onClosePhrase === "function" ? onClosePhrase : async () => {};
    this.onStatus = typeof onStatus === "function" ? onStatus : () => {};
    this.isRecorderBusy = typeof isRecorderBusy === "function" ? isRecorderBusy : () => false;
    this.enabled = false;
    this.armed = false;
    this.armedMode = null;
    this.closePhraseActive = false;
    this.activationInProgress = false;
    this.resampler = null;
    this.armPromise = null;
  }

  async setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      await this.disarm();
      await this._releaseIdleStream();
      this.closePhraseActive = false;
      this.onStatus({ enabled: false, armed: false });
      return { enabled: false, armed: false };
    }
    return this.arm();
  }

  async arm(mode = "wake") {
    if (!this.enabled) return { enabled: false, armed: false };
    if (this.armed && this.armedMode === mode) {
      return { enabled: this.enabled, armed: true, mode: this.armedMode };
    }
    if (this.armed) await this.disarm();
    if (this.armPromise) return this.armPromise;

    this.armPromise = this._arm(mode).finally(() => {
      this.armPromise = null;
    });
    return this.armPromise;
  }

  async _arm(mode) {
    try {
      if (mode === "wake" && this.isRecorderBusy()) {
        this.onStatus({ enabled: true, armed: false, waiting: true });
        return { enabled: true, armed: false, waiting: true };
      }
      await this.requestMicrophoneAccess();
      if (!this.enabled) {
        await this._releaseIdleStream();
        return { enabled: false, armed: false };
      }
      await this.audioEngine.ensureStream();
      if (!this.enabled) {
        await this._releaseIdleStream();
        return { enabled: false, armed: false };
      }
      const status = await this.startWakeWord({ mode });
      if (!this.enabled) {
        await this.stopWakeWord().catch(() => {});
        await this._releaseIdleStream();
        return { enabled: false, armed: false };
      }
      if (!status?.enabled) {
        throw new Error(status?.error || "Local wake detector could not start.");
      }
      const sourceRate = this.audioEngine.audioContext?.sampleRate || TARGET_SAMPLE_RATE;
      this.resampler = new LinearResampler(sourceRate, TARGET_SAMPLE_RATE);
      this.audioEngine.startPcmTap((samples) => this._handleSamples(samples));
      this.armed = true;
      this.armedMode = mode;
      this.onStatus({ enabled: true, armed: true, keyword: status.keyword, mode });
      return { enabled: true, armed: true, keyword: status.keyword, mode };
    } catch (error) {
      this.armed = false;
      this.audioEngine.stopPcmTap?.();
      await this.stopWakeWord().catch(() => {});
      this.onStatus({ enabled: this.enabled, armed: false, error: error?.message || "Wake phrase unavailable" });
      return { enabled: this.enabled, armed: false, error: error?.message || "Wake phrase unavailable" };
    }
  }

  async disarm() {
    this.armed = false;
    this.armedMode = null;
    this.activationInProgress = false;
    this.resampler?.reset();
    this.resampler = null;
    this.audioEngine.stopPcmTap?.();
    await this.stopWakeWord().catch(() => {});
  }

  async rearm() {
    if (!this.enabled) return { enabled: false, armed: false };
    await this.disarm();
    await this._releaseIdleStream();
    return this.arm();
  }

  async _releaseIdleStream() {
    if (this.isRecorderBusy() || typeof this.audioEngine.releaseStream !== "function") return;
    await Promise.resolve(this.audioEngine.releaseStream()).catch(() => {});
  }

  async handleWakeWord(payload) {
    if (!this.enabled || this.activationInProgress) return;
    if (payload?.mode === "close") {
      if (!this.closePhraseActive || !this.isRecorderBusy()) return;
      this.activationInProgress = true;
      await this.disarm();
      try {
        await this.onClosePhrase(payload);
      } finally {
        this.activationInProgress = false;
      }
      return;
    }
    if (this.isRecorderBusy()) return;
    this.activationInProgress = true;
    this.closePhraseActive = true;
    await this.disarm();
    try {
      await this.onWakeWord(payload);
    } finally {
      this.activationInProgress = false;
    }
  }

  async handleRecorderState(state, states) {
    if (!this.enabled) return;
    if (state === states.RECORDING && this.closePhraseActive) {
      await this.arm("close");
      return;
    }
    if ([states.ARMING, states.RECORDING, states.TRANSCRIBING, states.PASTING].includes(state)) {
      await this.disarm();
      return;
    }
    if (state === states.IDLE || state === states.ERROR) {
      this.closePhraseActive = false;
      await this.arm("wake");
    }
  }

  _handleSamples(samples) {
    if (!this.enabled || !this.armed || this.activationInProgress) return;
    const frame = this.resampler?.push(samples);
    if (frame?.length) this.sendWakeWordFrame(frame);
  }
}

export { LinearResampler, TARGET_SAMPLE_RATE };
