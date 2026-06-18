import { RecorderStateMachine, STATES } from "./recorder-state-machine.js";

const CHUNK_SIZE_LIMIT = 20 * 1024 * 1024; // 20MB

export class RecorderController {
  constructor({
    audioEngine,
    minRecordingDurationMs,
    mediaRecorderTimesliceMs,
    doneHideWindowMs = 900,
    hideWindow,
    scheduleHideWindow,
    cancelHideWindow,
    focusRestoreDelayMs = 120,
    requestMicrophoneAccess,
    transcribeAudio,
    transcribeAudioChunked,
    transcribePreview,
    processCommand,
    simulateTyping,
    updateStatus,
    updatePreview,
    onDiagnostics,
  }) {
    this.audioEngine = audioEngine;
    this.minRecordingDurationMs = minRecordingDurationMs;
    this.mediaRecorderTimesliceMs = mediaRecorderTimesliceMs;
    this.doneHideWindowMs = doneHideWindowMs;
    this.hideWindow = typeof hideWindow === "function" ? hideWindow : null;
    this.scheduleHideWindow = typeof scheduleHideWindow === "function" ? scheduleHideWindow : null;
    this.cancelHideWindow = typeof cancelHideWindow === "function" ? cancelHideWindow : null;
    this.focusRestoreDelayMs = focusRestoreDelayMs;
    this.requestMicrophoneAccess = requestMicrophoneAccess;
    this.transcribeAudio = transcribeAudio;
    this.transcribeAudioChunked = transcribeAudioChunked;
    this.transcribePreview = transcribePreview;
    this.processCommand = processCommand;
    this.simulateTyping = simulateTyping;
    this.updateStatus = updateStatus;
    this.updatePreview = typeof updatePreview === "function" ? updatePreview : () => {};
    this.onDiagnostics = typeof onDiagnostics === "function" ? onDiagnostics : () => {};

    this.mediaRecorder = null;
    this.audioChunks = [];
    this.mode = "dictation";
    this.selectedText = "";
    this.previewIntervalMs = 2500;
    this.previewTimer = null;
    this.previewRequestActive = false;
    this.stateMachine = new RecorderStateMachine(({ next, detail }) => {
      if (next === STATES.ERROR) this.updateStatus(detail || "Error", "red");
    });
  }

  setPreviewIntervalMs(value) {
    if (Number.isFinite(value) && value >= 1000) {
      this.previewIntervalMs = value;
    }
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

  async toggleRecording(options = {}) {
    const state = this.getState();
    if (state === STATES.RECORDING) {
      return this.stopRecording();
    }

    if (state !== STATES.IDLE && state !== STATES.ERROR) {
      return;
    }

    return this.startRecording(options);
  }

  async startRecording({ mode = "dictation", selectedText = "" } = {}) {
    try {
      this.mode = mode === "command" ? "command" : "dictation";
      this.selectedText = String(selectedText || "");
      if (this.cancelHideWindow) {
        await this.cancelHideWindow();
      }
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
      this.updateStatus(this.mode === "command" ? "Recording command..." : "Recording...", "red");
      this.updatePreview("", {
        mode: this.mode,
        phase: "recording",
        selectedText: this.selectedText,
      });
      this.startPreviewLoop();
      this.watchAudioLevels();
    } catch (error) {
      console.error("Error starting recording:", error);
      this.stateMachine.transition(STATES.ERROR, "Recording failed");
    }
  }

  stopRecording() {
    if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") return false;
    this.stopPreviewLoop();
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

  startPreviewLoop() {
    this.stopPreviewLoop();
    if (!this.transcribePreview) return;
    this.previewTimer = setInterval(() => {
      this.runPreviewTranscription().catch((error) => {
        console.warn("Preview transcription failed:", error);
      });
    }, this.previewIntervalMs);
  }

  stopPreviewLoop() {
    if (this.previewTimer) {
      clearInterval(this.previewTimer);
      this.previewTimer = null;
    }
  }

  async runPreviewTranscription() {
    if (this.getState() !== STATES.RECORDING || this.previewRequestActive) return;
    if (!this.audioChunks.length) return;

    this.previewRequestActive = true;
    const mode = this.mode;
    try {
      const audioBlob = new Blob(this.audioChunks, { type: "audio/webm" });
      if (audioBlob.size < 1000) return;
      const arrayBuffer = await audioBlob.arrayBuffer();
      const result = await this.transcribePreview(arrayBuffer);
      if (this.getState() !== STATES.RECORDING || mode !== this.mode) return;
      if (!result?.skipped && result?.text) {
        this.updatePreview(result.text, {
          mode,
          phase: "preview",
          selectedText: this.selectedText,
        });
      }
    } finally {
      this.previewRequestActive = false;
    }
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
    let transcript = null;
    let pasteOk = null;

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

      if (bytes > CHUNK_SIZE_LIMIT && this.transcribeAudioChunked) {
        // Split audioChunks into groups that each stay under the size limit
        const chunkGroups = this._splitChunks(this.audioChunks, CHUNK_SIZE_LIMIT);
        const sizeMB = (bytes / (1024 * 1024)).toFixed(1);
        console.log(`Large recording (${sizeMB}MB) — splitting into ${chunkGroups.length} chunks`);
        if (bytes > 100 * 1024 * 1024) {
          console.warn(`Very large recording (${sizeMB}MB) — transcription may take a while`);
        }
        const buffers = [];
        for (const group of chunkGroups) {
          const blob = new Blob(group, { type: "audio/webm" });
          buffers.push(await blob.arrayBuffer());
        }
        transcript = await this.transcribeAudioChunked(buffers);
      } else {
        transcript = await this.transcribeAudio(arrayBuffer);
      }
      transcribeMs = Date.now() - transcribeStartedAt;

      if (!transcript || typeof transcript !== "string" || !transcript.trim()) {
        this.updateStatus("No transcription, try again", "red");
        this.stateMachine.transition(STATES.IDLE, "Empty transcript");
        return;
      }

      this.updatePreview(transcript, {
        mode: this.mode,
        phase: "final",
        selectedText: this.selectedText,
      });
      this.stateMachine.transition(STATES.PASTING, "Injecting text");
      this.updateStatus(this.mode === "command" ? "Applying command..." : "Inserting text...", "green");

      let textToPaste = transcript;
      if (this.mode === "command") {
        textToPaste = await this.processCommand({
          selectedText: this.selectedText,
          instruction: transcript,
        });
        if (!textToPaste || !textToPaste.trim()) {
          this.updateStatus("Command returned no text", "red");
          this.stateMachine.transition(STATES.IDLE, "Empty command result");
          return;
        }
        this.updatePreview(textToPaste, {
          mode: this.mode,
          phase: "result",
          selectedText: this.selectedText,
        });
      }

      if (this.hideWindow) {
        try {
          await this.hideWindow();
          await new Promise((resolve) => setTimeout(resolve, this.focusRestoreDelayMs));
        } catch (_error) {
          // Ignore hide/focus handoff failures and still attempt paste.
        }
      }
      const pasteResult = await this.simulateTyping(textToPaste);
      const ok = typeof pasteResult === "boolean" ? pasteResult : !!pasteResult?.ok;
      pasteOk = ok;
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
      this.stopPreviewLoop();
      if (this.scheduleHideWindow) {
        this.scheduleHideWindow(this.doneHideWindowMs).catch((error) => {
          console.warn("Failed to schedule window hide:", error);
        });
      }
      this.onDiagnostics({
        type: "pipeline-latency",
        totalMs: Date.now() - pipelineStartedAt,
        preprocessMs,
        transcribeMs,
        pasteMs,
        restoreMs,
        clipboardRestoreMode,
        bytes,
        transcript: this.mode === "command" ? null : transcript,
        commandInstruction: this.mode === "command" ? transcript : null,
        commandSelectedChars: this.mode === "command" ? this.selectedText.length : null,
        pasteOk,
      });
    }
  }
  _splitChunks(audioChunks, sizeLimit) {
    const groups = [];
    let currentGroup = [];
    let currentSize = 0;

    for (const chunk of audioChunks) {
      if (currentSize + chunk.size > sizeLimit && currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
        currentSize = 0;
      }
      currentGroup.push(chunk);
      currentSize += chunk.size;
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups;
  }
}

export { STATES };
