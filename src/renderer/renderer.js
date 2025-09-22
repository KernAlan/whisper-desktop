// @ts-nocheck
let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let isAudioInitialized = false;
let audioContext;
let analyser;
const MIN_RECORDING_DURATION = 100;

async function initializeAudio() {
  try {
    await window.electronAPI.requestMicrophoneAccess();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    console.log("Audio stream initialized successfully");
    isAudioInitialized = true;
    return stream;
  } catch (error) {
    console.error("Error initializing audio:", error);
    throw error;
  }
}

async function startRecording() {
  try {
    if (!isAudioInitialized) {
      console.log("Initializing audio before first recording");
      await initializeAudio();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = (event) => {
      audioChunks.push(event.data);
    };
    mediaRecorder.onstop = handleRecordingStop;
    mediaRecorder.start();
    isRecording = true;
    console.log("Recording started");
    updateStatus("Recording...", "red");
    checkAudioLevels();
  } catch (error) {
    console.error("Error starting recording:", error);
    updateStatus("Recording failed", "black");
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    setTimeout(() => {
      mediaRecorder.stop();
      isRecording = false;
      console.log("Recording stopped");
      updateStatus("Processing...", "blue");
    }, MIN_RECORDING_DURATION);
    return true;
  }
  return false;
}

async function testMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new (window.AudioContext ||
      window.webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    const microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);
    analyser.fftSize = 256;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    function checkAudioLevel() {
      analyser.getByteFrequencyData(dataArray);
      const average =
        dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
      console.log("Microphone test - Audio level:", average);
      if (average > 10) {
        console.log("Microphone is working and detecting audio");
        updateStatus("Microphone is working", "green");
      } else {
        console.log("No significant audio detected");
        updateStatus("No audio detected, check your microphone", "red");
      }
    }

    // Check audio level for 3 seconds
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      checkAudioLevel();
    }

    stream.getTracks().forEach((track) => track.stop());
    audioContext.close();
  } catch (error) {
    console.error("Error testing microphone:", error);
    updateStatus("Error testing microphone", "red");
  }
}

async function listAudioDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioDevices = devices.filter(
      (device) => device.kind === "audioinput"
    );
    console.log("Available audio input devices:", audioDevices);
    audioDevices.forEach((device) => {
      console.log(`Device ID: ${device.deviceId}, Label: ${device.label}`);
    });
  } catch (error) {
    console.error("Error listing audio devices:", error);
  }
}

function checkAudioLevels() {
  if (!isRecording) return;

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(dataArray);
  const average =
    dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;

  requestAnimationFrame(checkAudioLevels);
}

function updateStatus(message, color) {
  const statusElement = document.getElementById("status");
  statusElement.textContent = message;
  statusElement.style.color = color;
}

async function handleRecordingStop() {
  try {
    console.log("Handling recording stop");
    const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
    console.log("Audio blob created, size:", audioBlob.size);

    const arrayBuffer = await audioBlob.arrayBuffer();
    console.log("ArrayBuffer created, size:", arrayBuffer.byteLength);

    if (arrayBuffer.byteLength < 1000) {
      console.warn("Audio data too small, possibly no audio captured");
      updateStatus("No audio captured, try again", "red");
      return;
    }

    updateStatus("Transcribing...", "blue");
    const response = await window.electronAPI.transcribeAudio(arrayBuffer);
    console.log("Transcription response:", response);

    if (response && typeof response === "string" && response.length > 0) {
      updateStatus("Simulating typing...", "green");
      const typingResult = await window.electronAPI.simulateTyping(response);
      if (typingResult && typingResult.success) {
        console.log("Typing simulated successfully");
        updateStatus("Done", "green");
      } else if (typingResult && typingResult.reason === "mac-accessibility") {
        console.warn(
          "macOS accessibility permission missing, cannot simulate typing"
        );
        updateStatus(
          "Enable accessibility access for Whisper Desktop in System Settings > Privacy & Security > Accessibility",
          "red"
        );
      } else {
        const errorMessage =
          typingResult && typingResult.error
            ? `Failed to simulate typing (${typingResult.error})`
            : "Failed to simulate typing";
        console.error(errorMessage);
        updateStatus(errorMessage, "red");
      }
    } else {
      console.warn(
        "Empty or invalid transcription result, skipping typing simulation"
      );
      updateStatus("No transcription, try again", "red");
    }
  } catch (error) {
    console.error("Error in handleRecordingStop:", error);
    updateStatus("Error processing audio", "red");
  } finally {
    audioChunks = [];
    console.log("Audio chunks cleared");
  }
}

console.log("Setting up onToggleRecording in renderer");
window.electronAPI.onToggleRecording(() => {
  console.log("onToggleRecording callback triggered in renderer");
  if (isRecording) {
    console.log("Stopping recording");
    if (!stopRecording()) {
      console.log("Failed to stop recording, starting new recording");
      startRecording();
    }
  } else {
    console.log("Starting recording");
    startRecording();
  }
});

console.log("Renderer script fully loaded");

// Initialize audio when the script loads
initializeAudio().catch((error) => {
  console.error("Failed to initialize audio on startup:", error);
  updateStatus("Failed to initialize audio", "red");
});

listAudioDevices();

document
  .getElementById("testMicButton")
  .addEventListener("click", testMicrophone);

window.electronAPI.onTranscriptionResult((result) => {
  console.log("Transcription result:", result);
  // Handle the transcription result (e.g., display it in the UI)
  const input = document.querySelector("input");
  if (input) {
    input.value += result + " ";
  }
});
