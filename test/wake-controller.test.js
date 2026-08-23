const test = require("node:test");
const assert = require("node:assert/strict");

test("WakeController resamples microphone PCM and arms the local detector", async () => {
  const { WakeController, LinearResampler } = await import("../src/renderer/core/wake-controller.js");
  const resampler = new LinearResampler(48000, 16000);
  assert.equal(resampler.push(new Float32Array(480)).length, 160);

  let pcmCallback = null;
  let startCalls = 0;
  let stopCalls = 0;
  let releaseCalls = 0;
  const frames = [];
  const statuses = [];
  const audioEngine = {
    audioContext: { sampleRate: 48000 },
    async ensureStream() {},
    startPcmTap(callback) {
      pcmCallback = callback;
    },
    stopPcmTap() {},
    async releaseStream() {
      releaseCalls += 1;
    },
  };
  const controller = new WakeController({
    audioEngine,
    requestMicrophoneAccess: async () => {},
    startWakeWord: async () => {
      startCalls += 1;
      return { enabled: true, keyword: "Hey Whisper" };
    },
    stopWakeWord: async () => {
      stopCalls += 1;
      return { enabled: false };
    },
    sendWakeWordFrame: (frame) => frames.push(frame),
    onWakeWord: async () => {},
    onStatus: (status) => statuses.push(status),
  });

  const armed = await controller.setEnabled(true);
  assert.equal(armed.armed, true);
  assert.equal(startCalls, 1);
  pcmCallback(new Float32Array(480));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 160);

  await controller.setEnabled(false);
  assert.equal(controller.armed, false);
  assert.equal(stopCalls, 1);
  assert.equal(releaseCalls, 1);
  assert.equal(statuses.at(-1).enabled, false);
});

test("WakeController waits to arm while the recorder is busy", async () => {
  const { WakeController } = await import("../src/renderer/core/wake-controller.js");
  let starts = 0;
  const controller = new WakeController({
    audioEngine: {
      audioContext: { sampleRate: 16000 },
      async ensureStream() {},
      startPcmTap() {},
      stopPcmTap() {},
    },
    requestMicrophoneAccess: async () => {},
    startWakeWord: async () => {
      starts += 1;
      return { enabled: true };
    },
    stopWakeWord: async () => ({ enabled: false }),
    sendWakeWordFrame: () => {},
    onWakeWord: async () => {},
    onClosePhrase: async () => {},
    isRecorderBusy: () => true,
  });

  const status = await controller.setEnabled(true);
  assert.equal(status.waiting, true);
  assert.equal(starts, 0);
  assert.equal(controller.enabled, true);
});

test("WakeController arms the close phrase while a wake recording is active", async () => {
  const { WakeController } = await import("../src/renderer/core/wake-controller.js");
  const modes = [];
  const controller = new WakeController({
    audioEngine: {
      audioContext: { sampleRate: 16000 },
      async ensureStream() {},
      startPcmTap() {},
      stopPcmTap() {},
    },
    requestMicrophoneAccess: async () => {},
    startWakeWord: async ({ mode }) => {
      modes.push(mode);
      return { enabled: true, keyword: mode === "close" ? "Stop Whisper" : "Hey Whisper" };
    },
    stopWakeWord: async () => ({ enabled: false }),
    sendWakeWordFrame: () => {},
    onWakeWord: async () => {},
    onClosePhrase: async () => {},
    isRecorderBusy: () => true,
  });

  await controller.setEnabled(true);
  controller.closePhraseActive = true;
  await controller.handleRecorderState("recording", { RECORDING: "recording" });

  assert.deepEqual(modes, ["close"]);
  assert.equal(controller.armedMode, "close");
});

test("RecorderController endpoints a wake activation locally", async () => {
  const { RecorderController, STATES } = await import("../src/renderer/core/recorder-controller.js");
  const controller = new RecorderController({
    audioEngine: { getAnalyser: () => null },
    minRecordingDurationMs: 0,
    mediaRecorderTimesliceMs: 150,
    wakeInitialTimeoutMs: 4000,
    requestMicrophoneAccess: async () => {},
    transcribeAudio: async () => "",
    updateStatus: () => {},
    updatePreview: () => {},
    updateRecoveryActions: () => {},
  });
  controller.stateMachine.transition(STATES.RECORDING, "test");
  controller.wakeRecording = true;
  controller.segmentStartedAt = 0;
  controller._isInputSilent = () => true;
  let stopCalls = 0;
  controller.stopRecording = () => {
    stopCalls += 1;
    return true;
  };

  controller._monitorSegment(4000);

  assert.equal(stopCalls, 1);
  assert.equal(controller.wakeDiscardRequested, true);
});

test("WakeController arms the close phrase for hotkey-started dictation too", async () => {
  const { WakeController } = await import("../src/renderer/core/wake-controller.js");
  const modes = [];
  let stopped = 0;
  const controller = new WakeController({
    audioEngine: {
      audioContext: { sampleRate: 16000 },
      async ensureStream() {},
      startPcmTap() {},
      stopPcmTap() {},
    },
    requestMicrophoneAccess: async () => {},
    startWakeWord: async ({ mode }) => {
      modes.push(mode);
      return { enabled: true, keyword: mode === "close" ? "Stop Whisper" : "Hey Whisper" };
    },
    stopWakeWord: async () => ({ enabled: false }),
    sendWakeWordFrame: () => {},
    onWakeWord: async () => {},
    onClosePhrase: async () => {
      stopped += 1;
    },
    isRecorderBusy: () => true,
  });

  await controller.setEnabled(true);
  // No wake phrase ran, so closePhraseActive is still false: this is the hotkey path.
  assert.equal(controller.closePhraseActive, false);
  await controller.handleRecorderState("recording", { RECORDING: "recording" });

  assert.deepEqual(modes, ["close"]);
  assert.equal(controller.armedMode, "close");

  await controller.handleWakeWord({ mode: "close", keyword: "Stop Whisper" });
  assert.equal(stopped, 1);
});

test("WakeController re-arms the wake phrase once dictation ends", async () => {
  const { WakeController } = await import("../src/renderer/core/wake-controller.js");
  const modes = [];
  let busy = true;
  const controller = new WakeController({
    audioEngine: {
      audioContext: { sampleRate: 16000 },
      async ensureStream() {},
      startPcmTap() {},
      stopPcmTap() {},
      async releaseStream() {},
    },
    requestMicrophoneAccess: async () => {},
    startWakeWord: async ({ mode }) => {
      modes.push(mode);
      return { enabled: true };
    },
    stopWakeWord: async () => ({ enabled: false }),
    sendWakeWordFrame: () => {},
    onWakeWord: async () => {},
    onClosePhrase: async () => {},
    isRecorderBusy: () => busy,
  });

  await controller.setEnabled(true);
  const states = { IDLE: "idle", ARMING: "arming", RECORDING: "recording", TRANSCRIBING: "transcribing", PASTING: "pasting", ERROR: "error" };
  await controller.handleRecorderState(states.RECORDING, states);
  assert.equal(controller.armedMode, "close");

  await controller.handleRecorderState(states.TRANSCRIBING, states);
  assert.equal(controller.armed, false);

  busy = false;
  await controller.handleRecorderState(states.IDLE, states);
  assert.equal(controller.closePhraseActive, false);
  assert.equal(controller.armedMode, "wake");
  assert.deepEqual(modes, ["close", "wake"]);
});
