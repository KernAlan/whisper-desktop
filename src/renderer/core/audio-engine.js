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

  async ensureStream({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.activeStream) {
      const hasLiveTrack = this.activeStream
        .getTracks()
        .some((track) => track.readyState === "live");
      if (hasLiveTrack) return this.activeStream;
    }

    const selectedDevice = await this.chooseDevice();
    const deviceId = selectedDevice?.deviceId;
    const constraints = {
      audio: deviceId
        ? {
            deviceId: { exact: deviceId },
            noiseSuppression: true,
            echoCancellation: true,
            autoGainControl: true,
          }
        : {
            noiseSuppression: true,
            echoCancellation: true,
            autoGainControl: true,
          },
    };

    if (this.activeStream) {
      this.activeStream.getTracks().forEach((track) => track.stop());
    }

    this.activeStream = await navigator.mediaDevices.getUserMedia(constraints);
    this.activeDevice = {
      id: selectedDevice?.deviceId || "default",
      label: selectedDevice?.label || "default input",
    };
    this.setPreferredDeviceId(this.activeDevice.id);
    this.onDiagnostics({
      type: "mic-selected",
      label: this.activeDevice.label,
      deviceId: this.activeDevice.id,
    });

    if (this.audioContext && this.audioContext.state !== "closed") {
      await this.audioContext.close();
    }
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.audioContext.createAnalyser();
    const source = this.audioContext.createMediaStreamSource(this.activeStream);
    source.connect(this.analyser);

    return this.activeStream;
  }

  getAnalyser() {
    return this.analyser;
  }

  getActiveDevice() {
    return this.activeDevice || { id: "default", label: "default input" };
  }
}
