window.addEventListener("DOMContentLoaded", (event) => {
  console.log("DOM fully loaded and parsed");
  const script = document.createElement("script");
  script.src = "./src/renderer/renderer.js";
  script.onload = () => {
    console.log("Renderer script loaded");
    if (window.electronAPI && window.electronAPI.onToggleRecording) {
      console.log("electronAPI.onToggleRecording is available");
    } else {
      console.error("electronAPI.onToggleRecording is not available");
    }
  };
  script.onerror = (error) =>
    console.error("Error loading renderer script:", error.message);
  document.body.appendChild(script);
});

window.onerror = function (message, source, lineno, colno, error) {
  console.error(
    "Global error:",
    message,
    "at",
    source,
    ":",
    lineno,
    ":",
    colno,
    error
  );
};
