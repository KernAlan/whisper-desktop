import { formatError, serializeError } from "./error-utils.js";

function isPermissionError(error) {
  return (
    error?.name === "NotAllowedError" ||
    error?.name === "SecurityError" ||
    error?.name === "PermissionDeniedError"
  );
}

function createAudioConstraints(deviceId) {
  const audioOptions = {
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
  };

  if (deviceId && deviceId !== "default") {
    audioOptions.deviceId = { exact: deviceId };
  }

  return { audio: audioOptions };
}

export class AudioEngine {
  constructor({ chooseDevice, setPreferredDeviceId, onDiagnostics }) {
    this.chooseDevice = chooseDevice;
    this.setPreferredDeviceId = setPreferredDeviceId;
    this.onDiagnostics = typeof onDiagnostics === "function" ? onDiagnostics : () => {};
    this.audioContext = null;
    this.analyser = null;
    this.mediaSource = null;
    this.pcmTap = null;
    this.activeStream = null;
    this.activeDevice = null;
  }

  async refreshDeviceSelection() {
    const selectedDevice = await this.chooseDevice();
    if (!selectedDevice) {
      this.activeDevice = null;
      return null;
    }

    this.activeDevice = {
      id: selectedDevice.deviceId || "default",
      label: selectedDevice.label || "default input",
    };
    this.setPreferredDeviceId(this.activeDevice.id);
    return this.activeDevice;
  }

  async ensureStream({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.activeStream) {
      const hasLiveTrack = this.activeStream
        .getTracks()
        .some((track) => track.readyState === "live");
      if (hasLiveTrack) return this.activeStream;
    }

    const selectedDevice = await this.chooseDevice();
    const deviceId = selectedDevice?.deviceId;
    const constraints = createAudioConstraints(deviceId);

    await this.releaseStream();

    let usedFallbackDevice = false;
    try {
      this.activeStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      this.onDiagnostics({
        type: "mic-stream-error",
        stage: deviceId ? "selected-device" : "default-device",
        label: selectedDevice?.label || "default input",
        deviceId: deviceId || "default",
        error: serializeError(error),
      });

      if (!deviceId || isPermissionError(error)) {
        throw error;
      }

      console.warn(`Selected microphone failed; retrying default input. ${formatError(error)}`);
      usedFallbackDevice = true;
      this.activeStream = await navigator.mediaDevices.getUserMedia(createAudioConstraints(null));
    }

    const activeTrack = this.activeStream.getAudioTracks()[0];
    this.activeDevice = {
      id: usedFallbackDevice ? "default" : selectedDevice?.deviceId || "default",
      label: activeTrack?.label || (usedFallbackDevice ? "default input" : selectedDevice?.label) || "default input",
    };
    this.setPreferredDeviceId(this.activeDevice.id);
    this.onDiagnostics({
      type: "mic-selected",
      label: this.activeDevice.label,
      deviceId: this.activeDevice.id,
    });

    try {
      if (this.audioContext && this.audioContext.state !== "closed") {
        await this.audioContext.close();
      }
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      const source = this.audioContext.createMediaStreamSource(this.activeStream);
      this.mediaSource = source;
      source.connect(this.analyser);
      if (this.audioContext.state === "suspended") {
        if (typeof this.audioContext.resume !== "function") {
          throw new Error("The local audio context could not be resumed.");
        }
        await this.audioContext.resume();
      }
    } catch (error) {
      await this.releaseStream();
      throw error;
    }

    return this.activeStream;
  }

  async releaseStream() {
    this.stopPcmTap();
    if (this.activeStream) {
      this.activeStream.getTracks().forEach((track) => track.stop());
      this.activeStream = null;
    }
    this.analyser = null;
    this.mediaSource = null;

    if (this.audioContext && this.audioContext.state !== "closed") {
      const context = this.audioContext;
      this.audioContext = null;
      await context.close();
    } else {
      this.audioContext = null;
    }
  }

  getAnalyser() {
    return this.analyser;
  }

  startPcmTap(onSamples) {
    this.stopPcmTap();
    if (!this.audioContext || !this.mediaSource || typeof onSamples !== "function") {
      throw new Error("Audio stream is not ready for local audio processing.");
    }
    if (typeof this.audioContext.createScriptProcessor !== "function") {
      throw new Error("This platform does not expose a local PCM audio tap.");
    }

    const processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    const mute = this.audioContext.createGain();
    mute.gain.value = 0;
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer?.getChannelData?.(0);
      if (input?.length) onSamples(new Float32Array(input));
    };
    this.mediaSource.connect(processor);
    processor.connect(mute);
    mute.connect(this.audioContext.destination);
    this.pcmTap = { processor, mute };
    return true;
  }

  stopPcmTap() {
    if (!this.pcmTap) return;
    const { processor, mute } = this.pcmTap;
    processor.onaudioprocess = null;
    this.mediaSource?.disconnect?.(processor);
    processor.disconnect?.();
    mute.disconnect?.();
    this.pcmTap = null;
  }

  getActiveDevice() {
    return this.activeDevice || { id: "default", label: "default input" };
  }
}
