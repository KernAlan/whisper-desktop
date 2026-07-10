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

function createAudioContextClass({ failSource = false, closedContexts = [] } = {}) {
  return class FakeAudioContext {
    constructor() {
      this.state = "running";
      closedContexts.push(this);
    }

    createAnalyser() {
      return {};
    }

    createMediaStreamSource() {
      if (failSource) throw new Error("source setup failed");
      return { connect() {} };
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
