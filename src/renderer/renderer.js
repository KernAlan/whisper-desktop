// @ts-nocheck

let mediaRecorder;
let audioChunks = [];
let isRecording = false;

async function startRecording() {
  try {
    await window.electronAPI.requestMicrophoneAccess();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (event) => {
      audioChunks.push(event.data);
    };
    mediaRecorder.onstop = handleRecordingStop;
    mediaRecorder.start();
    isRecording = true;
    console.log("Recording started");
    document.getElementById("status").textContent = "Recording...";
  } catch (error) {
    console.error("Error starting recording:", error);
    document.getElementById("status").textContent = "Recording failed";
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    isRecording = false;
    console.log("Recording stopped");
    document.getElementById("status").textContent = "Not recording";
    return true;
  }
  return false;
}

async function handleRecordingStop() {
  try {
    console.log("Handling recording stop");
    const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
    console.log("Audio blob created, size:", audioBlob.size);

    const arrayBuffer = await audioBlob.arrayBuffer();
    console.log("ArrayBuffer created, size:", arrayBuffer.byteLength);

    const response = await window.electronAPI.transcribeAudio(arrayBuffer);
    console.log("Transcription response:", response);

    if (response && typeof response === "string" && response.length > 0) {
      const success = await window.electronAPI.simulateTyping(response);
      if (success) {
        console.log("Typing simulated successfully");
      } else {
        console.error("Failed to simulate typing");
      }
    } else {
      console.warn(
        "Empty or invalid transcription result, skipping typing simulation"
      );
    }
  } catch (error) {
    console.error("Error in handleRecordingStop:", error);
  } finally {
    audioChunks = [];
    console.log("Audio chunks cleared");
  }
}

function simulateTyping(text) {
  const activeElement = document.activeElement;
  if (
    activeElement &&
    (activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA")
  ) {
    const event = new InputEvent("input", {
      inputType: "insertText",
      data: text,
      bubbles: true,
      cancelable: true,
    });
    activeElement.value += text;
    activeElement.dispatchEvent(event);
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

window.electronAPI.onTranscriptionResult((result) => {
  console.log("Transcription result:", result);
  // Handle the transcription result (e.g., display it in the UI)
  const input = document.querySelector("input");
  if (input) {
    input.value += result + " ";
  }
});
