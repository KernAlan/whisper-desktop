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
      source.connect(this.analyser);
    } catch (error) {
      await this.releaseStream();
      throw error;
    }

    return this.activeStream;
  }

  async releaseStream() {
    if (this.activeStream) {
      this.activeStream.getTracks().forEach((track) => track.stop());
      this.activeStream = null;
    }
    this.analyser = null;

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

  getActiveDevice() {
    return this.activeDevice || { id: "default", label: "default input" };
  }
}
