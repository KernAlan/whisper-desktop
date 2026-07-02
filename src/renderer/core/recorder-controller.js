import { RecorderStateMachine, STATES } from "./recorder-state-machine.js";
import { formatError, microphoneStatusForError, userMessageForFailure } from "./error-utils.js";

const CHUNK_SIZE_LIMIT = 20 * 1024 * 1024; // 20MB
const PREVIEW_SIZE_LIMIT = 2 * 1024 * 1024; // Preview is UX only; keep long recordings for final transcription.
const AUTO_RECOVERY_RETRY_DELAYS_MS = [1500];

export class RecorderController {
  constructor({
    audioEngine,
    minRecordingDurationMs,
    mediaRecorderTimesliceMs,
    doneHideWindowMs = 900,
    hideWindow,
    dismissWindow,
    scheduleHideWindow,
    cancelHideWindow,
    focusRestoreDelayMs = 120,
    requestMicrophoneAccess,
    transcribeAudio,
    transcribeAudioChunked,
    transcribePreview,
    retryRecovery,
    deleteRecovery,
    listTranscripts,
    polishDictation,
    processCommand,
    simulateTyping,
    copyText,
    updateStatus,
    updatePreview,
    updateRecoveryActions,
    onDiagnostics,
  }) {
    this.audioEngine = audioEngine;
    this.minRecordingDurationMs = minRecordingDurationMs;
    this.mediaRecorderTimesliceMs = mediaRecorderTimesliceMs;
    this.doneHideWindowMs = doneHideWindowMs;
    this.hideWindow = typeof hideWindow === "function" ? hideWindow : null;
    this.dismissWindow = typeof dismissWindow === "function" ? dismissWindow : null;
    this.scheduleHideWindow = typeof scheduleHideWindow === "function" ? scheduleHideWindow : null;
    this.cancelHideWindow = typeof cancelHideWindow === "function" ? cancelHideWindow : null;
    this.focusRestoreDelayMs = focusRestoreDelayMs;
    this.requestMicrophoneAccess = requestMicrophoneAccess;
    this.transcribeAudio = transcribeAudio;
    this.transcribeAudioChunked = transcribeAudioChunked;
    this.transcribePreview = transcribePreview;
    this.retryRecovery = typeof retryRecovery === "function" ? retryRecovery : null;
    this.deleteRecovery = typeof deleteRecovery === "function" ? deleteRecovery : null;
    this.listTranscripts = typeof listTranscripts === "function" ? listTranscripts : null;
    this.polishDictation = polishDictation;
    this.processCommand = processCommand;
    this.simulateTyping = simulateTyping;
    this.copyText = typeof copyText === "function" ? copyText : null;
    this.updateStatus = updateStatus;
    this.updatePreview = typeof updatePreview === "function" ? updatePreview : () => {};
    this.updateRecoveryActions = typeof updateRecoveryActions === "function" ? updateRecoveryActions : () => {};
    this.onDiagnostics = typeof onDiagnostics === "function" ? onDiagnostics : () => {};

    this.mediaRecorder = null;
    this.audioChunks = [];
    this.mode = "dictation";
    this.dictationMode = "polished";
    this.selectedText = "";
    this.selection = { ok: true, chars: 0, text: "" };
    this.previewIntervalMs = 1500;
    this.previewTimer = null;
    this.recordingStatusTimer = null;
    this.processingStatusTimer = null;
    this.recordingStartedAt = 0;
    this.processingStartedAt = 0;
    this.previewText = "";
    this.previewPartCount = 0;
    this.previewFailureCount = 0;
    this.previewRequestActive = false;
    this.lastRecovery = null;
    this.lastOutputText = "";
    this.pendingRecoveryCleanupTarget = "";
    this.activePipelineId = 0;
    this.cancelledPipelineIds = new Set();
    this.activeRecoveryRetryId = 0;
    this.cancelledRecoveryRetryIds = new Set();
    this.stateMachine = new RecorderStateMachine(({ next, detail }) => {
      if (next === STATES.ERROR) this.updateStatus(detail || "Error", "red");
    });
  }

  setPreviewIntervalMs(value) {
    if (Number.isFinite(value) && value >= 1000) {
      this.previewIntervalMs = value;
    }
  }

  setDoneHideWindowMs(value) {
    if (Number.isFinite(value) && value > 0) {
      this.doneHideWindowMs = value;
    }
  }

  setDictationMode(value) {
    if (value === "fast" || value === "polished") {
      this.dictationMode = value;
    }
  }

  getState() {
    return this.stateMachine.getState();
  }

  async initialize() {
    try {
      this.stateMachine.transition(STATES.ARMING, "Checking microphone");
      const selectedDevice = await this.audioEngine.refreshDeviceSelection();
      if (!selectedDevice) {
        this.updateStatus("No microphone found", "red");
        this.stateMachine.transition(STATES.ERROR, "No microphone found");
        return;
      }
      const activeDevice = this.audioEngine.getActiveDevice();
      this.updateStatus(`Ready (${activeDevice.label})`, "black");
      this.stateMachine.transition(STATES.IDLE, "Ready");
    } catch (error) {
      this.stateMachine.transition(STATES.ERROR, microphoneStatusForError(error));
      throw error;
    }
  }

  async toggleRecording(options = {}) {
    if (options?.showRecovery) {
      return this.showRecoveryConsole();
    }

    const state = this.getState();
    if (state === STATES.RECORDING) {
      return this.stopRecording();
    }

    if (state !== STATES.IDLE && state !== STATES.ERROR) {
      return;
    }

    return this.startRecording(options);
  }

  async startRecording({ mode = "dictation", selectedText = "", selection, dictationMode } = {}) {
    try {
      this.mode = mode === "command" ? "command" : "dictation";
      if (dictationMode) this.setDictationMode(dictationMode);
      this.selection = selection && typeof selection === "object"
        ? selection
        : { ok: Boolean(selectedText), text: String(selectedText || ""), chars: String(selectedText || "").length };
      this.selectedText = String(this.selection.text || selectedText || "");
      if (this.cancelHideWindow) {
        await this.cancelHideWindow();
      }
      this.stateMachine.transition(STATES.ARMING, "Preparing recording");
      await this.requestMicrophoneAccess();
      const stream = await this.audioEngine.ensureStream();
      this.mediaRecorder = new MediaRecorder(stream);
      this.audioChunks = [];
      this.previewText = "";
      this.previewPartCount = 0;
      this.previewFailureCount = 0;
      this.lastRecovery = null;
      this.pendingRecoveryCleanupTarget = "";
      this.updateRecoveryActions(null);
      this.recordingStartedAt = Date.now();
      this.mediaRecorder.ondataavailable = (event) => this.audioChunks.push(event.data);
      this.mediaRecorder.onstop = () => {
        this.handleRecordingStop().catch((error) => {
          console.error("Failed processing recording:", error);
          this.stateMachine.transition(STATES.ERROR, "Error processing audio");
        });
      };
      this.mediaRecorder.start(this.mediaRecorderTimesliceMs);
      this.stateMachine.transition(STATES.RECORDING, "Recording");
      if (this.mode === "command") {
        const chars = this.selectedText.length;
        this.updateStatus(chars ? `Command mode (${chars} selected chars)` : "Command mode (no selection)", chars ? "red" : "blue");
      } else {
        this.updateStatus("Recording...", "red");
      }
      this.updatePreview("", {
        mode: this.mode,
        phase: "recording",
        selectedText: this.selectedText,
        selection: this.selection,
      });
      this.startPreviewLoop();
      this.startRecordingStatusLoop();
    } catch (error) {
      await this._releaseAudioStream("start failure");
      console.error(`Error starting recording: ${formatError(error)}`);
      const status = microphoneStatusForError(error);
      this.updatePreview(userMessageForFailure(error, status), {
        mode: this.mode,
        phase: "error",
        selectedText: this.selectedText,
        selection: this.selection,
      });
      this.updateRecoveryActions({
        show: true,
        retryMic: true,
        testMic: true,
        settings: true,
        dismiss: true,
      });
      this.stateMachine.transition(STATES.ERROR, status);
    }
  }

  stopRecording() {
    if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") return false;
    this.stopPreviewLoop();
    this.stopRecordingStatusLoop();
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
    setTimeout(() => {
      this.runPreviewTranscription().catch((error) => {
        console.warn("Initial preview transcription failed:", error);
      });
    }, Math.max(800, Math.floor(this.previewIntervalMs * 0.7)));
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
    const snapshotEnd = this.audioChunks.length;
    const chunksForPreview = this.audioChunks.slice(0, snapshotEnd);
    try {
      const audioBlob = new Blob(chunksForPreview, { type: "audio/webm" });
      if (audioBlob.size < 1000) return;
      if (audioBlob.size > PREVIEW_SIZE_LIMIT) return;
      const arrayBuffer = await audioBlob.arrayBuffer();
      const result = await this.transcribePreview(arrayBuffer);
      if (this.getState() !== STATES.RECORDING || mode !== this.mode) return;
      if (!result?.skipped && result?.text) {
        this.previewFailureCount = 0;
        this.previewText = String(result.text || "").trim();
        this.previewPartCount += 1;
        this.updatePreview(this.previewText, {
          mode,
          phase: "preview",
          selectedText: this.selectedText,
          selection: this.selection,
          previewParts: this.previewPartCount,
        });
      } else if (result?.error) {
        this.previewFailureCount += 1;
        if (this.previewFailureCount === 3) {
          this.onDiagnostics({
            type: "preview-degraded",
            error: result.error,
          });
        }
      }
    } finally {
      this.previewRequestActive = false;
    }
  }

  startRecordingStatusLoop() {
    this.stopRecordingStatusLoop();
    this.recordingStatusTimer = setInterval(() => this.updateRecordingStatus(), 1000);
  }

  stopRecordingStatusLoop() {
    if (this.recordingStatusTimer) {
      clearInterval(this.recordingStatusTimer);
      this.recordingStatusTimer = null;
    }
  }

  startProcessingStatusLoop(label) {
    this.stopProcessingStatusLoop();
    this.processingStartedAt = Date.now();
    this.processingStatusTimer = setInterval(() => {
      const elapsed = this._formatDuration(Date.now() - this.processingStartedAt);
      this.updateStatus(`${label} ${elapsed}...`, "blue");
    }, 1000);
  }

  stopProcessingStatusLoop() {
    if (this.processingStatusTimer) {
      clearInterval(this.processingStatusTimer);
      this.processingStatusTimer = null;
    }
  }

  updateRecordingStatus() {
    if (this.getState() !== STATES.RECORDING) return;
    const elapsed = this._formatDuration(Date.now() - this.recordingStartedAt);
    if (this.mode === "command") {
      const chars = this.selectedText.length;
      this.updateStatus(
        chars
          ? `Command ${elapsed} | ${chars} selected chars`
          : `Command ${elapsed} | no selection`,
        chars ? "red" : "blue"
      );
      return;
    }

    this.updateStatus(`Recording ${elapsed}`, "red");
  }

  async handleRecordingStop() {
    const pipelineId = this._beginPipeline();
    const pipelineStartedAt = Date.now();
    let transcribeMs = 0;
    let preprocessMs = 0;
    let pasteMs = 0;
    let restoreMs = 0;
    let polishMs = 0;
    let pasteChunks = 0;
    let clipboardRestoreMode = "unknown";
    let bytes = 0;
    let transcript = null;
    let outputText = null;
    let pasteOk = null;
    let keepWindowVisible = false;
    let cancelled = false;
    const stopIfCancelled = () => {
      if (!this._isPipelineCancelled(pipelineId)) return false;
      cancelled = true;
      keepWindowVisible = true;
      return true;
    };

    try {
      await this._releaseAudioStream("recording stop");
      this.stateMachine.transition(STATES.TRANSCRIBING, "Transcribing");
      this.updateStatus("Transcribing...", "blue");
      this.updateRecoveryActions({
        show: true,
        processing: true,
        dismiss: true,
        cancel: true,
      });
      this.startProcessingStatusLoop("Transcribing");
      const preprocessStartedAt = Date.now();
      const audioBlob = new Blob(this.audioChunks, { type: "audio/webm" });
      const arrayBuffer = await audioBlob.arrayBuffer();
      if (stopIfCancelled()) return;
      preprocessMs = Date.now() - preprocessStartedAt;
      bytes = arrayBuffer.byteLength;

      if (bytes < 1000) {
        keepWindowVisible = true;
        this.updateStatus("No audio captured, try again", "red");
        this.updatePreview("No audio was captured. Check the selected microphone or try a longer recording.", {
          mode: this.mode,
          phase: "error",
          selectedText: this.selectedText,
          selection: this.selection,
        });
        this.updateRecoveryActions({
          show: true,
          retryMic: true,
          testMic: true,
          dismiss: true,
        });
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
          if (stopIfCancelled()) return;
        }
        transcript = await this._transcribeWithAutoRecovery(() =>
          this.transcribeAudioChunked(buffers)
        );
      } else {
        transcript = await this._transcribeWithAutoRecovery(() =>
          this.transcribeAudio(arrayBuffer)
        );
      }
      if (stopIfCancelled()) return;
      transcribeMs = Date.now() - transcribeStartedAt;
      this.stopProcessingStatusLoop();

      if (!transcript || typeof transcript !== "string" || !transcript.trim()) {
        keepWindowVisible = true;
        const draftText = this._bestDraftText();
        this.lastRecovery = draftText
          ? {
              show: true,
              partialText: draftText,
              copyPartial: true,
              pastePartial: true,
              dismiss: true,
            }
          : null;
        this.updateStatus("No transcription, try again", "red");
        this.updatePreview(
          draftText
            ? "No final transcription came back. You can copy or paste the draft text below."
            : "No speech was transcribed. Try again, or test the microphone if this repeats.",
          {
            mode: this.mode,
            phase: "error",
            selectedText: this.selectedText,
            selection: this.selection,
          }
        );
        this.updateRecoveryActions({
          show: true,
          copyPartial: Boolean(draftText),
          pastePartial: Boolean(draftText),
          retryMic: true,
          testMic: true,
          dismiss: true,
        });
        this.stateMachine.transition(STATES.IDLE, "Empty transcript");
        return;
      }

      const output = await this._processTranscriptForPaste(transcript, {
        shouldCancel: () => this._isPipelineCancelled(pipelineId),
      });
      if (output.cancelled || stopIfCancelled()) return;
      outputText = output.outputText;
      polishMs = output.polishMs;
      pasteOk = output.pasteOk;
      pasteMs = output.pasteMs;
      restoreMs = output.restoreMs;
      pasteChunks = output.pasteChunks;
      clipboardRestoreMode = output.clipboardRestoreMode;
      if (!pasteOk) keepWindowVisible = true;
      await this._cleanupRecoveredAudioIfSafe(output);
    } catch (error) {
      if (stopIfCancelled()) return;
      console.error("Pipeline error:", error);
      this.stopProcessingStatusLoop();
      const recoveryFiles = Array.isArray(error?.recoveryFiles) ? error.recoveryFiles : [];
      if (recoveryFiles.length) {
        const target = error.recoveryTarget || this._recoveryTarget(recoveryFiles);
        const partialText = this._bestDraftText(error.partialText);
        const count = recoveryFiles.length;
        const label = count === 1 ? "saved audio" : `${count} saved chunks`;
        const command = `node cli.js retry ${target}`;
        this.lastRecovery = {
          show: true,
          target,
          partialText,
          command,
          mode: this.mode,
          savedAudio: true,
          copyPartial: Boolean(partialText),
          pastePartial: Boolean(partialText),
          copyCommand: true,
          dismiss: true,
        };
        this.onDiagnostics({
          type: "recovery-saved",
          target,
          count,
          partialChars: partialText.length,
        });
        if (partialText && this.copyText) {
          await this.copyText(partialText).catch(() => {});
        }
        this.updateStatus(`Recovery saved. Manual retry needed: ${label}`, "red");
        this.updatePreview(
          partialText
            ? "Automatic retry failed. Draft text was copied. You can paste it or retry the saved audio below."
            : "Automatic retry failed. You can retry the saved audio below.",
          {
            mode: this.mode,
            phase: "error",
            selectedText: this.selectedText,
            selection: this.selection,
          }
        );
        this.updateRecoveryActions(this.lastRecovery);
        keepWindowVisible = true;
        this.stateMachine.transition(STATES.IDLE, "Recovery saved");
      } else {
        keepWindowVisible = true;
        const draftText = this._bestDraftText(error.partialText);
        this.lastRecovery = draftText
          ? {
              show: true,
              partialText: draftText,
              copyPartial: true,
              pastePartial: true,
              dismiss: true,
            }
          : null;
        const message = userMessageForFailure(error, "Error processing audio");
        this.updateStatus(message, "red");
        this.updatePreview(draftText ? `${message}. Draft text is available below.` : message, {
          mode: this.mode,
          phase: "error",
          selectedText: this.selectedText,
          selection: this.selection,
        });
        this.updateRecoveryActions({
          show: true,
          copyPartial: Boolean(draftText),
          pastePartial: Boolean(draftText),
          copyOutput: Boolean(this.lastOutputText),
          settings: true,
          dismiss: true,
        });
        this.stateMachine.transition(STATES.ERROR, "Error processing audio");
      }
    } finally {
      this.audioChunks = [];
      this.stopPreviewLoop();
      this.stopRecordingStatusLoop();
      this.stopProcessingStatusLoop();
      if (this._isPipelineCancelled(pipelineId)) {
        cancelled = true;
        keepWindowVisible = true;
      }
      if (!keepWindowVisible && this.scheduleHideWindow) {
        this.scheduleHideWindow(this.doneHideWindowMs).catch((error) => {
          console.warn("Failed to schedule window hide:", error);
        });
      }
      if (this.activePipelineId === pipelineId) {
        this.activePipelineId = 0;
      }
      this.cancelledPipelineIds.delete(pipelineId);
      this.onDiagnostics({
        type: "pipeline-latency",
        cancelled,
        totalMs: Date.now() - pipelineStartedAt,
        preprocessMs,
        transcribeMs,
        pasteMs,
        restoreMs,
        polishMs,
        pasteChunks,
        clipboardRestoreMode,
        bytes,
        transcript: this.mode === "command" ? null : transcript,
        outputText: this.mode === "dictation" ? outputText : null,
        polished: this.mode === "dictation" && this.dictationMode === "polished",
        commandInstruction: this.mode === "command" ? transcript : null,
        commandSelectedChars: this.mode === "command" ? this.selectedText.length : null,
        commandSelectionOk: this.mode === "command" ? this.selection.ok !== false : null,
        commandOutputChars: this.mode === "command" && outputText ? outputText.length : null,
        pasteOk,
      });
    }
  }

  async retrySavedRecovery() {
    if (!this.lastRecovery?.target || !this.retryRecovery) {
      this.updateStatus("No saved recovery available", "red");
      return false;
    }

    const retryId = this._beginRecoveryRetry();
    const stopIfCancelled = () => {
      if (!this._isRecoveryRetryCancelled(retryId)) return false;
      return true;
    };

    this.updateRecoveryActions({
      show: true,
      processing: true,
      dismiss: true,
      cancel: true,
    });
    this.updateStatus("Retrying saved audio...", "blue");
    this.updatePreview("Retrying saved recording.", {
      mode: this.lastRecovery.mode || this.mode,
      phase: "recovering",
      selectedText: this.selectedText,
      selection: this.selection,
    });
    this.startProcessingStatusLoop("Retrying saved audio");

    try {
      const transcript = this._readTranscriptionResult(
        await this.retryRecovery(this.lastRecovery.target, { removeOnSuccess: false })
      );
      if (stopIfCancelled()) return false;
      this.stopProcessingStatusLoop();
      const recoveryTarget = this.lastRecovery.target;
      this.pendingRecoveryCleanupTarget = recoveryTarget;
      this.lastRecovery = null;
      this.updateRecoveryActions(null);
      const output = await this._processTranscriptForPaste(transcript, {
        shouldCancel: () => this._isRecoveryRetryCancelled(retryId),
      });
      if (output.cancelled || stopIfCancelled()) return false;
      await this._cleanupRecoveredAudioIfSafe(output, recoveryTarget);
      if (this.scheduleHideWindow) {
        this.scheduleHideWindow(this.doneHideWindowMs).catch((error) => {
          console.warn("Failed to schedule window hide:", error);
        });
      }
      return true;
    } catch (error) {
      if (stopIfCancelled()) return false;
      this.stopProcessingStatusLoop();
      this.updateStatus("Retry failed. Saved audio is still available.", "red");
      this.updateRecoveryActions({ ...this.lastRecovery, show: true });
      return false;
    } finally {
      if (this.activeRecoveryRetryId === retryId) {
        this.activeRecoveryRetryId = 0;
      }
      this.cancelledRecoveryRetryIds.delete(retryId);
    }
  }

  async copyRecoveryPartial() {
    const text = this.lastRecovery?.partialText || "";
    if (!text.trim() || !this.copyText) {
      this.updateStatus("No draft text to copy", "red");
      return false;
    }
    await this.copyText(text);
    this.updateStatus("Draft text copied", "green");
    return true;
  }

  async pasteRecoveryPartial() {
    const text = this.lastRecovery?.partialText || "";
    if (!text.trim()) {
      this.updateStatus("No draft text to paste", "red");
      return false;
    }

    this.updateStatus("Pasting draft...", "blue");
    const pasteResult = await this.simulateTyping(text);
    const ok = typeof pasteResult === "boolean" ? pasteResult : !!pasteResult?.ok;
    if (ok) {
      this.updateStatus("Done", "green");
      this.stateMachine.transition(STATES.IDLE, "Done");
      this.updatePreview("Inserted. Backup text is still on the clipboard.", {
        mode: "dictation",
        phase: "recovery",
      });
      this.updateRecoveryActions({
        show: true,
        copyPartial: Boolean(text),
        pastePartial: Boolean(text),
        history: true,
        dismiss: true,
      });
      if (this.scheduleHideWindow) {
        this.scheduleHideWindow(this.doneHideWindowMs).catch((error) => {
          console.warn("Failed to schedule window hide:", error);
        });
      }
      return true;
    }

    if (this.copyText) {
      await this.copyText(text).catch(() => {});
    }
    this.updateStatus("Paste failed; draft copied", "red");
    this.updateRecoveryActions({ ...this.lastRecovery, show: true, dismiss: true });
    return false;
  }

  async copyRecoveryCommand() {
    const command = this.lastRecovery?.command || "";
    if (!command.trim() || !this.copyText) {
      this.updateStatus("No recovery command to copy", "red");
      return false;
    }
    await this.copyText(command);
    this.updateStatus("Retry command copied", "green");
    return true;
  }

  async copyLastOutput() {
    if (!this.lastOutputText.trim() || !this.copyText) {
      this.updateStatus("No text to copy", "red");
      return false;
    }
    await this.copyText(this.lastOutputText);
    this.updateStatus("Text copied", "green");
    return true;
  }

  async retryLastPaste() {
    if (!this.lastOutputText.trim()) {
      this.updateStatus("No text to paste", "red");
      return false;
    }

    this.updateStatus("Retrying paste...", "blue");
    try {
      const pasteResult = await this.simulateTyping(this.lastOutputText);
      const ok = typeof pasteResult === "boolean" ? pasteResult : !!pasteResult?.ok;
      if (ok) {
        this.updateStatus("Done", "green");
        this.stateMachine.transition(STATES.IDLE, "Done");
        this.updateRecoveryActions({
          show: true,
          retryPaste: true,
          copyOutput: true,
          history: true,
          dismiss: true,
        });
        if (this.scheduleHideWindow) {
          this.scheduleHideWindow(this.doneHideWindowMs).catch((error) => {
            console.warn("Failed to schedule window hide:", error);
          });
        }
        return true;
      }
      this.updateStatus("Paste still failed", "red");
      return false;
    } catch (error) {
      this.updateStatus("Paste still failed", "red");
      return false;
    }
  }

  async dismissWindowNow() {
    const state = this.getState();
    if (state === STATES.RECORDING && this.mediaRecorder?.state !== "inactive") {
      this.stopRecording();
    } else {
      await this._releaseAudioStream("dismiss");
    }
    if (this.activePipelineId || state === STATES.TRANSCRIBING || state === STATES.PASTING) {
      this._cancelActivePipeline();
    }
    if (this.activeRecoveryRetryId || state === STATES.TRANSCRIBING || state === STATES.PASTING) {
      this._cancelActiveRecoveryRetry();
    }
    this.stopPreviewLoop();
    this.stopRecordingStatusLoop();
    this.stopProcessingStatusLoop();
    this.updateRecoveryActions(null);
    if (state !== STATES.RECORDING) {
      this.stateMachine.transition(STATES.IDLE, "Dismissed");
    }
    if (this.dismissWindow) {
      await this.dismissWindow();
    } else if (this.scheduleHideWindow) {
      await this.scheduleHideWindow(1);
    }
    return true;
  }

  async showRecoveryConsole() {
    this.stopPreviewLoop();
    this.stopRecordingStatusLoop();
    this.stopProcessingStatusLoop();
    this.stateMachine.transition(STATES.IDLE, "Recovery");
    this.updateStatus("Recovery", "blue");

    const text = this._bestDraftText();
    if (text) {
      this.setRecoveryText(text);
      return true;
    }

    const entries = await this.loadTranscriptHistory(5);
    const latest = entries[0];
    if (latest?.text) {
      this.setRecoveryText(latest.text);
      return true;
    }

    this.updatePreview("No saved transcripts yet.", {
      mode: "dictation",
      phase: "recovery",
    });
    this.updateRecoveryActions({
      show: true,
      history: true,
      dismiss: true,
    });
    return false;
  }

  async loadTranscriptHistory(limit = 5) {
    if (!this.listTranscripts) return [];
    try {
      return await this.listTranscripts(limit);
    } catch (error) {
      console.warn("Failed to load transcript history:", error);
      return [];
    }
  }

  setRecoveryText(text) {
    const value = String(text || "").trim();
    if (!value) {
      this.updateStatus("No text to recover", "red");
      return false;
    }
    this.lastRecovery = {
      show: true,
      partialText: value,
      copyPartial: true,
      pastePartial: true,
      history: true,
      dismiss: true,
    };
    this.lastOutputText = value;
    this.updatePreview(value, {
      mode: "dictation",
      phase: "recovery",
    });
    this.updateRecoveryActions(this.lastRecovery);
    this.updateStatus("Recovered text ready", "green");
    return true;
  }

  async _processTranscriptForPaste(transcript, { shouldCancel } = {}) {
    const isCancelled = () => typeof shouldCancel === "function" && shouldCancel();
    let polishMs = 0;
    let textToPaste = transcript;
    const cancelledResult = () => ({
      outputText: textToPaste || "",
      polishMs,
      pasteOk: null,
      pasteMs: 0,
      restoreMs: 0,
      pasteChunks: 0,
      clipboardRestoreMode: "unknown",
      cancelled: true,
    });

    if (isCancelled()) return cancelledResult();

    this.updatePreview(transcript, {
      mode: this.mode,
      phase: "final",
      selectedText: this.selectedText,
      selection: this.selection,
    });
    this.stateMachine.transition(STATES.PASTING, "Injecting text");
    this.updateStatus(this.mode === "command" ? "Applying command..." : "Inserting text...", "green");
    this.updateRecoveryActions({
      show: true,
      processing: true,
      dismiss: true,
      cancel: true,
    });

    if (isCancelled()) return cancelledResult();

    if (this.mode === "command") {
      textToPaste = await this.processCommand({
        selectedText: this.selectedText,
        instruction: transcript,
      });
      if (isCancelled()) return cancelledResult();
      if (!textToPaste || !textToPaste.trim()) {
        this.updateStatus("Command returned no text", "red");
        this.stateMachine.transition(STATES.IDLE, "Empty command result");
        return {
          outputText: "",
          polishMs,
          pasteOk: false,
          pasteMs: 0,
          restoreMs: 0,
          pasteChunks: 0,
          clipboardRestoreMode: "unknown",
        };
      }
      this.updatePreview(textToPaste, {
        mode: this.mode,
        phase: "result",
        selectedText: this.selectedText,
        selection: this.selection,
      });
    } else if (this.dictationMode === "polished" && this.polishDictation) {
      this.updateStatus("Polishing...", "blue");
      try {
        const polishStartedAt = Date.now();
        const polishedText = await this.polishDictation({ transcript });
        polishMs = Date.now() - polishStartedAt;
        if (isCancelled()) return cancelledResult();
        if (polishedText && polishedText.trim()) {
          textToPaste = polishedText;
          this.updatePreview(textToPaste, {
            mode: this.mode,
            phase: "polished",
            selectedText: this.selectedText,
            selection: this.selection,
          });
        }
      } catch (polishError) {
        console.warn("Dictation polishing failed; using raw transcript:", polishError);
        this.updateStatus("Polish failed; inserting transcript", "green");
      }
    }

    if (isCancelled()) return cancelledResult();
    this.lastOutputText = textToPaste;
    if (this.hideWindow) {
      try {
        await this.hideWindow();
        await new Promise((resolve) => setTimeout(resolve, this.focusRestoreDelayMs));
      } catch (_error) {
        // Ignore hide/focus handoff failures and still attempt paste.
      }
    }
    if (isCancelled()) return cancelledResult();
    const pasteResult = await this.simulateTyping(textToPaste);
    if (isCancelled()) return cancelledResult();
    const ok = typeof pasteResult === "boolean" ? pasteResult : !!pasteResult?.ok;
    if (ok) {
      this.updateStatus("Done", "green");
      this.updatePreview("Inserted. Backup text is still on the clipboard.", {
        mode: this.mode,
        phase: "recovery",
        selectedText: this.selectedText,
        selection: this.selection,
      });
      this.stateMachine.transition(STATES.IDLE, "Done");
      this.updateRecoveryActions({
        show: true,
        retryPaste: true,
        copyOutput: true,
        history: true,
        dismiss: true,
      });
    } else {
      const error = pasteResult?.error || "Paste failed";
      if (this.copyText) {
        await this.copyText(textToPaste).catch(() => {});
      }
      if (pasteResult?.error === "accessibility-not-trusted") {
        this.updateStatus("Enable Accessibility permission for Whisper Desktop", "red");
      } else {
        this.updateStatus("Paste failed; text copied", "red");
      }
      this.updatePreview("Paste failed. The generated text is still available below.", {
        mode: this.mode,
        phase: "error",
        selectedText: this.selectedText,
        selection: this.selection,
      });
      this.updateRecoveryActions({
        show: true,
        retryPaste: true,
        copyOutput: true,
        history: true,
        settings: true,
        dismiss: true,
      });
      this.onDiagnostics({
        type: "paste-failed",
        mode: this.mode,
        chars: textToPaste.length,
        error,
      });
      this.stateMachine.transition(STATES.ERROR, "Failed to insert text");
    }

    return {
      outputText: textToPaste,
      polishMs,
      pasteOk: ok,
      pasteMs: Number(pasteResult?.pasteMs || 0),
      restoreMs: Number(pasteResult?.restoreMs || 0),
      pasteChunks: Number(pasteResult?.chunks || 0),
      clipboardRestoreMode: pasteResult?.restoreMode || "unknown",
    };
  }

  _readTranscriptionResult(result) {
    if (typeof result === "string") return result;
    if (result?.ok) return result.text || "";
    const error = new Error(result?.error || "Transcription failed");
    error.recoveryFiles = Array.isArray(result?.recoveryFiles) ? result.recoveryFiles : [];
    error.partialText = typeof result?.partialText === "string" ? result.partialText : "";
    throw error;
  }

  async _transcribeWithAutoRecovery(runTranscription) {
    try {
      return this._readTranscriptionResult(await runTranscription());
    } catch (error) {
      const recoveryFiles = Array.isArray(error?.recoveryFiles) ? error.recoveryFiles : [];
      if (!recoveryFiles.length || !this.retryRecovery) throw error;

      const target = this._recoveryTarget(recoveryFiles);
      this.stopProcessingStatusLoop();
      this.updatePreview(
        "Connection issue. Saved the recording and retrying automatically.",
        {
          mode: this.mode,
          phase: "recovering",
          selectedText: this.selectedText,
          selection: this.selection,
        }
      );

      let lastError = error;
      for (let i = 0; i < AUTO_RECOVERY_RETRY_DELAYS_MS.length; i += 1) {
        const attempt = i + 1;
        const total = AUTO_RECOVERY_RETRY_DELAYS_MS.length;
        this.updateStatus(`Retrying saved recording ${attempt}/${total}...`, "blue");
        await this._sleep(AUTO_RECOVERY_RETRY_DELAYS_MS[i]);
        this.startProcessingStatusLoop(`Retrying saved recording ${attempt}/${total}`);
        try {
          const text = this._readTranscriptionResult(
            await this.retryRecovery(target, { removeOnSuccess: false })
          );
          this.stopProcessingStatusLoop();
          this.pendingRecoveryCleanupTarget = target;
          this.updateStatus("Recovered transcription", "green");
          return text;
        } catch (retryError) {
          this.stopProcessingStatusLoop();
          lastError = retryError;
        }
      }

      lastError.recoveryFiles = recoveryFiles;
      lastError.partialText = lastError.partialText || error.partialText || "";
      lastError.recoveryTarget = target;
      throw lastError;
    }
  }

  _recoveryTarget(recoveryFiles) {
    const first = recoveryFiles[0] || {};
    if (first.total > 1 && first.sessionId) return first.sessionId;
    return first.name || "latest";
  }

  _bestDraftText(primary = "") {
    const candidates = [
      primary,
      this.previewText,
      this.lastOutputText,
    ];
    for (const candidate of candidates) {
      const text = typeof candidate === "string" ? candidate.trim() : "";
      if (text) return text;
    }
    return "";
  }

  async _cleanupRecoveredAudioIfSafe(output, explicitTarget = "") {
    const target = explicitTarget || this.pendingRecoveryCleanupTarget;
    if (!target || !output?.pasteOk || !this.deleteRecovery) return;
    try {
      await this.deleteRecovery(target);
      this.pendingRecoveryCleanupTarget = "";
    } catch (error) {
      console.warn("Failed to delete recovered audio after paste:", error);
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async _releaseAudioStream(reason) {
    if (!this.audioEngine || typeof this.audioEngine.releaseStream !== "function") return;
    try {
      await this.audioEngine.releaseStream();
    } catch (error) {
      console.warn(`Failed to release microphone stream (${reason}):`, error);
    }
  }

  _beginPipeline() {
    this.activePipelineId += 1;
    return this.activePipelineId;
  }

  _cancelActivePipeline() {
    if (this.activePipelineId) {
      this.cancelledPipelineIds.add(this.activePipelineId);
    }
  }

  _isPipelineCancelled(pipelineId) {
    return Boolean(pipelineId && this.cancelledPipelineIds.has(pipelineId));
  }

  _beginRecoveryRetry() {
    this.activeRecoveryRetryId += 1;
    return this.activeRecoveryRetryId;
  }

  _cancelActiveRecoveryRetry() {
    if (this.activeRecoveryRetryId) {
      this.cancelledRecoveryRetryIds.add(this.activeRecoveryRetryId);
    }
  }

  _isRecoveryRetryCancelled(retryId) {
    return Boolean(retryId && this.cancelledRecoveryRetryIds.has(retryId));
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

  _formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }
}

export { STATES };
