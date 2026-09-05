const test = require("node:test");
const assert = require("node:assert/strict");

function installBrowserAudioStubs({ getUserMedia, AudioContext }) {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousWindow = globalThis.window;

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia,
      },
    },
  });
  globalThis.window = { AudioContext };

  return () => {
    if (previousNavigator) {
      Object.defineProperty(globalThis, "navigator", previousNavigator);
    } else {
      delete globalThis.navigator;
    }
    globalThis.window = previousWindow;
  };
}

function createTrack() {
  return {
    readyState: "live",
    stopped: false,
    stop() {
      this.stopped = true;
      this.readyState = "ended";
    },
  };
}

function createStream(track, label = "Desk Mic") {
  return {
    getTracks() {
      return [track];
    },
    getAudioTracks() {
      return [{ label }];
    },
  };
}

function createAudioContextClass({ failSource = false, closedContexts = [], initialState = "running", resumedContexts = [] } = {}) {
  return class FakeAudioContext {
    constructor() {
      this.state = initialState;
      closedContexts.push(this);
    }

    createAnalyser() {
      return {};
    }

    createMediaStreamSource() {
      if (failSource) throw new Error("source setup failed");
      return { connect() {} };
    }

    async resume() {
      resumedContexts.push(this);
      this.state = "running";
    }

    async close() {
      this.state = "closed";
    }
  };
}

async function waitFor(assertion, timeoutMs = 1000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError || new Error("Timed out");
}

function createControllerDeps(overrides = {}) {
  const noop = () => {};
  return {
    minRecordingDurationMs: 0,
    mediaRecorderTimesliceMs: 150,
    doneHideWindowMs: 1,
    hideWindow: null,
    dismissWindow: async () => {},
    scheduleHideWindow: async () => {},
    cancelHideWindow: async () => {},
    requestMicrophoneAccess: async () => true,
    transcribeAudio: async () => "hello world",
    transcribeAudioChunked: null,
    transcribePreview: null,
    transcribeCheckpoint: null,
    retryRecovery: null,
    deleteRecovery: null,
    listTranscripts: null,
    polishDictation: null,
    processCommand: null,
    simulateTyping: async () => ({ ok: true }),
    copyText: null,
    updateStatus: noop,
    updatePreview: noop,
    updateRecoveryActions: noop,
    onDiagnostics: noop,
    ...overrides,
  };
}

test("AudioEngine selection does not open capture and releaseStream stops capture", async () => {
  const { AudioEngine } = await import("../src/renderer/core/audio-engine.js");
  const track = createTrack();
  const closedContexts = [];
  let getUserMediaCalls = 0;
  const restore = installBrowserAudioStubs({
    getUserMedia: async () => {
      getUserMediaCalls += 1;
      return createStream(track);
    },
    AudioContext: createAudioContextClass({ closedContexts }),
  });

  try {
    const preferred = [];
    const engine = new AudioEngine({
      chooseDevice: async () => ({ deviceId: "desk-mic", label: "Desk Mic" }),
      setPreferredDeviceId: (id) => preferred.push(id),
      onDiagnostics: () => {},
    });

    const selected = await engine.refreshDeviceSelection();
    assert.deepEqual(selected, { id: "desk-mic", label: "Desk Mic" });
    assert.equal(getUserMediaCalls, 0);

    await engine.ensureStream();
    assert.equal(getUserMediaCalls, 1);
    assert.equal(track.stopped, false);

    await engine.releaseStream();
    assert.equal(track.stopped, true);
    assert.equal(engine.activeStream, null);
    assert.equal(engine.getAnalyser(), null);
    assert.equal(closedContexts[0].state, "closed");
    assert.deepEqual(preferred, ["desk-mic", "desk-mic"]);
  } finally {
    restore();
  }
});

test("AudioEngine releases capture if WebAudio setup fails after getUserMedia", async () => {
  const { AudioEngine } = await import("../src/renderer/core/audio-engine.js");
  const track = createTrack();
  const restore = installBrowserAudioStubs({
    getUserMedia: async () => createStream(track),
    AudioContext: createAudioContextClass({ failSource: true }),
  });

  try {
    const engine = new AudioEngine({
      chooseDevice: async () => ({ deviceId: "desk-mic", label: "Desk Mic" }),
      setPreferredDeviceId: () => {},
      onDiagnostics: () => {},
    });

    await assert.rejects(engine.ensureStream(), /source setup failed/);
    assert.equal(track.stopped, true);
    assert.equal(engine.activeStream, null);
  } finally {
    restore();
  }
});

test("AudioEngine resumes a suspended context for local PCM processing", async () => {
  const { AudioEngine } = await import("../src/renderer/core/audio-engine.js");
  const resumedContexts = [];
  const restore = installBrowserAudioStubs({
    getUserMedia: async () => createStream(createTrack()),
    AudioContext: createAudioContextClass({ initialState: "suspended", resumedContexts }),
  });

  try {
    const engine = new AudioEngine({
      chooseDevice: async () => ({ deviceId: "desk-mic", label: "Desk Mic" }),
      setPreferredDeviceId: () => {},
      onDiagnostics: () => {},
    });

    await engine.ensureStream();
    assert.equal(resumedContexts.length, 1);
    assert.equal(engine.audioContext.state, "running");
  } finally {
    restore();
  }
});

test("RecorderController initialize selects device without requesting or opening mic", async () => {
  const { RecorderController, STATES } = await import("../src/renderer/core/recorder-controller.js");
  let requestAccessCalls = 0;
  let ensureStreamCalls = 0;
  let refreshSelectionCalls = 0;

  const controller = new RecorderController(createControllerDeps({
    audioEngine: {
      async refreshDeviceSelection() {
        refreshSelectionCalls += 1;
        return { id: "desk-mic", label: "Desk Mic" };
      },
      async ensureStream() {
        ensureStreamCalls += 1;
        throw new Error("should not open stream during initialize");
      },
      getActiveDevice() {
        return { id: "desk-mic", label: "Desk Mic" };
      },
      async releaseStream() {},
    },
    requestMicrophoneAccess: async () => {
      requestAccessCalls += 1;
      return true;
    },
  }));

  await controller.initialize();

  assert.equal(controller.getState(), STATES.IDLE);
  assert.equal(refreshSelectionCalls, 1);
  assert.equal(requestAccessCalls, 0);
  assert.equal(ensureStreamCalls, 0);
});

test("RecorderController waits for the matching asynchronous target context", async () => {
  const { RecorderController } = await import("../src/renderer/core/recorder-controller.js");
  const controller = new RecorderController(createControllerDeps());
  controller.targetCaptureId = "capture-1";
  controller.targetContextPending = true;

  const waiting = controller._waitForTargetContext(100);
  assert.equal(controller.setTargetContext("stale-capture", { available: true }), false);
  setTimeout(() => {
    controller.setTargetContext("capture-1", {
      available: true,
      platform: "win32",
      windowId: "42",
      appName: "editor",
    });
  }, 10);

  const context = await waiting;
  assert.equal(context.appName, "editor");
  assert.equal(controller.targetContextPending, false);
});

test("RecorderController releases mic when a recording stops", async () => {
  const { RecorderController, STATES } = await import("../src/renderer/core/recorder-controller.js");
  const previousMediaRecorder = globalThis.MediaRecorder;
  let releaseCalls = 0;
  let ensureStreamCalls = 0;
  let transcribeCalls = 0;

  class FakeMediaRecorder {
    constructor(stream) {
      this.stream = stream;
      this.state = "inactive";
    }

    start() {
      this.state = "recording";
    }

    requestData() {}

    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([new Uint8Array(1200)]) });
      this.onstop?.();
    }
  }

  globalThis.MediaRecorder = FakeMediaRecorder;

  try {
    const controller = new RecorderController(createControllerDeps({
      audioEngine: {
        async refreshDeviceSelection() {
          return { id: "desk-mic", label: "Desk Mic" };
        },
        async ensureStream() {
          ensureStreamCalls += 1;
          return {};
        },
        getActiveDevice() {
          return { id: "desk-mic", label: "Desk Mic" };
        },
        async releaseStream() {
          releaseCalls += 1;
        },
      },
      transcribeAudio: async () => {
        transcribeCalls += 1;
        assert.equal(releaseCalls, 1);
        return "hello world";
      },
    }));

    await controller.startRecording();
    assert.equal(controller.getState(), STATES.RECORDING);
    assert.equal(ensureStreamCalls, 1);

    assert.equal(controller.stopRecording(), true);
    await waitFor(() => assert.equal(controller.getState(), STATES.IDLE));

    assert.equal(releaseCalls, 1);
    assert.equal(transcribeCalls, 1);
  } finally {
    globalThis.MediaRecorder = previousMediaRecorder;
  }
});

test("RecorderController rotates a quiet long recording and assembles stable checkpoints", async () => {
  const { RecorderController, STATES } = await import("../src/renderer/core/recorder-controller.js");
  const previousMediaRecorder = globalThis.MediaRecorder;
  const checkpointIndexes = [];
  const pasted = [];
  let finalTranscribeCalls = 0;

  class FakeMediaRecorder {
    constructor() {
      this.state = "inactive";
    }
    start() {
      this.state = "recording";
    }
    requestData() {}
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([new Uint8Array(1200)]) });
      this.onstop?.();
    }
  }
  globalThis.MediaRecorder = FakeMediaRecorder;

  try {
    const controller = new RecorderController(createControllerDeps({
      segmentMinMs: 0,
      segmentMaxMs: 100000,
      segmentSilenceMs: 0,
      segmentMonitorMs: 100000,
      audioEngine: {
        async ensureStream() { return {}; },
        getAnalyser() {
          return {
            fftSize: 8,
            getFloatTimeDomainData(values) { values.fill(0); },
          };
        },
        async releaseStream() {},
      },
      transcribeAudio: async () => {
        finalTranscribeCalls += 1;
        return "unexpected";
      },
      transcribeCheckpoint: async (_buffer, options) => {
        checkpointIndexes.push(options.index);
        return {
          ok: true,
          text: options.index === 0 ? "first segment" : "second segment",
          recovery: {
            name: `segment-${options.index}`,
            sessionId: options.sessionId,
            index: options.index,
            total: 0,
            checkpoint: true,
          },
        };
      },
      deleteRecovery: async () => ({ ok: true }),
      simulateTyping: async (text) => {
        pasted.push(text);
        return { ok: true };
      },
    }));

    await controller.startRecording();
    controller._monitorSegment(controller.segmentStartedAt + 1000);
    await waitFor(() => assert.equal(checkpointIndexes.length, 1));
    assert.equal(await controller.toggleRecording({ showRecovery: true }), true);
    await waitFor(() => assert.equal(controller.getState(), STATES.IDLE));

    assert.deepEqual(checkpointIndexes, [0, 1]);
    assert.equal(finalTranscribeCalls, 0);
    assert.deepEqual(pasted, ["first segment second segment"]);
  } finally {
    globalThis.MediaRecorder = previousMediaRecorder;
  }
});

test("RecorderController hands focus back while the polish request is still in flight", async () => {
  const { RecorderController } = await import("../src/renderer/core/recorder-controller.js");
  const order = [];
  let hiddenBeforePolishResolved = false;

  const controller = new RecorderController(createControllerDeps({
    focusRestoreDelayMs: 5,
    hideWindow: async () => {
      order.push("hide");
    },
    polishDictation: async ({ transcript }) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      hiddenBeforePolishResolved = order.includes("hide");
      order.push("polish");
      return `${transcript}.`;
    },
    simulateTyping: async () => {
      order.push("paste");
      return { ok: true };
    },
  }));

  const result = await controller._processTranscriptForPaste("hello world");

  // The hide must land during the polish call, not after it. Running it
  // afterwards put the full focus handoff on every dictation's critical path.
  assert.equal(hiddenBeforePolishResolved, true);
  assert.deepEqual(order, ["hide", "polish", "paste"]);
  assert.equal(result.outputText, "hello world.");
});

test("RecorderController still hands focus back when no polish runs", async () => {
  const { RecorderController } = await import("../src/renderer/core/recorder-controller.js");
  const order = [];
  const controller = new RecorderController(createControllerDeps({
    focusRestoreDelayMs: 5,
    hideWindow: async () => {
      order.push("hide");
    },
    simulateTyping: async () => {
      order.push("paste");
      return { ok: true };
    },
  }));
  controller.setDictationMode("fast");

  await controller._processTranscriptForPaste("hello world");

  assert.deepEqual(order, ["hide", "paste"]);
});

test("RecorderController drops the close phrase before polishing or pasting", async () => {
  const { RecorderController } = await import("../src/renderer/core/recorder-controller.js");
  const polished = [];
  let pastedText = "";

  const controller = new RecorderController(createControllerDeps({
    focusRestoreDelayMs: 1,
    transcribeAudio: async () => "Take all the items home. Stop whisper.",
    polishDictation: async ({ transcript }) => {
      polished.push(transcript);
      return transcript;
    },
    simulateTyping: async (text) => {
      pastedText = text;
      return { ok: true };
    },
  }));

  await controller.handleRecordingStop([new Blob([new Uint8Array(2000)])]);

  // The phrase must be gone before the polish sees it: asking the model to
  // punctuate "Stop whisper." is how it came back as "Stop, whisper."
  assert.deepEqual(polished, ["Take all the items home."]);
  assert.equal(pastedText, "Take all the items home.");
});

test("RecorderController trims a clipped close phrase only when the detector stopped it", async () => {
  const { RecorderController, STATES } = await import("../src/renderer/core/recorder-controller.js");

  async function pasteAfterStop({ closePhrase }) {
    let pastedText = "";
    const controller = new RecorderController(createControllerDeps({
      focusRestoreDelayMs: 1,
      minRecordingDurationMs: 0,
      // The detector cut the recording mid-phrase, so this is all that came back.
      transcribeAudio: async () => "Take all the items home. Stop.",
      simulateTyping: async (text) => {
        pastedText = text;
        return { ok: true };
      },
    }));
    controller.setDictationMode("fast");
    controller.stateMachine.transition(STATES.RECORDING, "test");
    controller.recordingStartedAt = Date.now();
    controller.stopRecording(closePhrase ? { closePhrase: true } : undefined);
    await controller.handleRecordingStop([new Blob([new Uint8Array(2000)])]);
    return pastedText;
  }

  assert.equal(await pasteAfterStop({ closePhrase: true }), "Take all the items home.");
  // The hotkey tells us nothing about what was said, so "Stop." stays.
  assert.equal(await pasteAfterStop({ closePhrase: false }), "Take all the items home. Stop.");
});
