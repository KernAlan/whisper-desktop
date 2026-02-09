import { RecorderStateMachine, STATES } from "./recorder-state-machine.js";

export class RecorderController {
  constructor({
    audioEngine,
    minRecordingDurationMs,
    mediaRecorderTimesliceMs,
    hideWindow,
    focusRestoreDelayMs = 120,
    requestMicrophoneAccess,
    transcribeAudio,
    simulateTyping,
    updateStatus,
    onDiagnostics,
  }) {
    this.audioEngine = audioEngine;
    this.minRecordingDurationMs = minRecordingDurationMs;
    this.mediaRecorderTimesliceMs = mediaRecorderTimesliceMs;
    this.hideWindow = typeof hideWindow === "function" ? hideWindow : null;
    this.focusRestoreDelayMs = focusRestoreDelayMs;
    this.requestMicrophoneAccess = requestMicrophoneAccess;
    this.transcribeAudio = transcribeAudio;
    this.simulateTyping = simulateTyping;
    this.updateStatus = updateStatus;
    this.onDiagnostics = typeof onDiagnostics === "function" ? onDiagnostics : () => {};

    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stateMachine = new RecorderStateMachine(({ next, detail }) => {
      if (next === STATES.ERROR) this.updateStatus(detail || "Error", "red");
    });
  }

  getState() {
    return this.stateMachine.getState();
  }

  async initialize() {
    this.stateMachine.transition(STATES.ARMING, "Initializing microphone");
    await this.requestMicrophoneAccess();
    await this.audioEngine.ensureStream();
    const activeDevice = this.audioEngine.getActiveDevice();
    this.updateStatus(`Ready (${activeDevice.label})`, "black");
    this.stateMachine.transition(STATES.IDLE, "Ready");
  }

  async toggleRecording() {
    const state = this.getState();
    if (state === STATES.RECORDING) {
      return this.stopRecording();
    }

    if (state !== STATES.IDLE && state !== STATES.ERROR) {
      return;
    }

    return this.startRecording();
  }

  async startRecording() {
    try {
      this.stateMachine.transition(STATES.ARMING, "Preparing recording");
      const stream = await this.audioEngine.ensureStream();
      this.mediaRecorder = new MediaRecorder(stream);
      this.audioChunks = [];
      this.mediaRecorder.ondataavailable = (event) => this.audioChunks.push(event.data);
      this.mediaRecorder.onstop = () => {
        this.handleRecordingStop().catch((error) => {
          console.error("Failed processing recording:", error);
          this.stateMachine.transition(STATES.ERROR, "Error processing audio");
        });
      };
      this.mediaRecorder.start(this.mediaRecorderTimesliceMs);
      this.stateMachine.transition(STATES.RECORDING, "Recording");
      this.updateStatus("Recording...", "red");
      this.watchAudioLevels();
    } catch (error) {
      console.error("Error starting recording:", error);
      this.stateMachine.transition(STATES.ERROR, "Recording failed");
    }
  }

  stopRecording() {
    if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") return false;
    setTimeout(() => {
      if (typeof this.mediaRecorder.requestData === "function") {
        try {
          this.mediaRecorder.requestData();
        } catch (_error) {
          // Ignore requestData issues before stop.
        }
      }
      this.mediaRecorder.stop();
      this.updateStatus("Processing...", "blue");
    }, this.minRecordingDurationMs);
    return true;
  }

  watchAudioLevels() {
    if (this.getState() !== STATES.RECORDING) return;
    const analyser = this.audioEngine.getAnalyser();
    if (!analyser) return;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);
    requestAnimationFrame(() => this.watchAudioLevels());
  }

  async handleRecordingStop() {
    const pipelineStartedAt = Date.now();
    let transcribeMs = 0;
    let preprocessMs = 0;
    let pasteMs = 0;
    let restoreMs = 0;
    let clipboardRestoreMode = "unknown";
    let bytes = 0;

    try {
      this.stateMachine.transition(STATES.TRANSCRIBING, "Transcribing");
      this.updateStatus("Transcribing...", "blue");
      const preprocessStartedAt = Date.now();
      const audioBlob = new Blob(this.audioChunks, { type: "audio/webm" });
      const arrayBuffer = await audioBlob.arrayBuffer();
      preprocessMs = Date.now() - preprocessStartedAt;
      bytes = arrayBuffer.byteLength;

      if (bytes < 1000) {
        this.updateStatus("No audio captured, try again", "red");
        this.stateMachine.transition(STATES.IDLE, "No audio");
        return;
      }

      const transcribeStartedAt = Date.now();
      const transcript = await this.transcribeAudio(arrayBuffer);
      transcribeMs = Date.now() - transcribeStartedAt;

      if (!transcript || typeof transcript !== "string" || !transcript.trim()) {
        this.updateStatus("No transcription, try again", "red");
        this.stateMachine.transition(STATES.IDLE, "Empty transcript");
        return;
      }

      this.stateMachine.transition(STATES.PASTING, "Injecting text");
      this.updateStatus("Inserting text...", "green");
      if (this.hideWindow) {
        try {
          await this.hideWindow();
          await new Promise((resolve) => setTimeout(resolve, this.focusRestoreDelayMs));
        } catch (_error) {
          // Ignore hide/focus handoff failures and still attempt paste.
        }
      }
      const pasteResult = await this.simulateTyping(transcript);
      const ok = typeof pasteResult === "boolean" ? pasteResult : !!pasteResult?.ok;
      pasteMs = Number(pasteResult?.pasteMs || 0);
      restoreMs = Number(pasteResult?.restoreMs || 0);
      clipboardRestoreMode = pasteResult?.restoreMode || "unknown";
      if (ok) {
        this.updateStatus("Done", "green");
        this.stateMachine.transition(STATES.IDLE, "Done");
      } else {
        if (pasteResult?.error === "accessibility-not-trusted") {
          this.updateStatus("Enable Accessibility permission for Whisper Desktop", "red");
        }
        this.stateMachine.transition(STATES.ERROR, "Failed to insert text");
      }
    } catch (error) {
      console.error("Pipeline error:", error);
      this.stateMachine.transition(STATES.ERROR, "Error processing audio");
    } finally {
      this.audioChunks = [];
      this.onDiagnostics({
        type: "pipeline-latency",
        totalMs: Date.now() - pipelineStartedAt,
        preprocessMs,
        transcribeMs,
        pasteMs,
        restoreMs,
        clipboardRestoreMode,
        bytes,
      });
    }
  }
}

export { STATES };
