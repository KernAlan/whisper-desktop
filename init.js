window.addEventListener("DOMContentLoaded", (event) => {
  console.log("DOM fully loaded and parsed");
  const script = document.createElement("script");
  script.src = "renderer.js";
  script.onload = () => console.log("Renderer script loaded");
  script.onerror = (error) =>
    console.error("Error loading renderer script:", error);
  document.body.appendChild(script);
});
