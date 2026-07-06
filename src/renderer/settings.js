import { formatError, microphoneStatusForError } from "./core/error-utils.js";

const fields = [
  "shortcut",
  "commandShortcut",
  "model",
  "textModel",
  "timeoutMs",
  "previewIntervalMs",
  "doneHideWindowMs",
  "polishChunkWords",
  "polishMaxWords",
  "pasteChunkChars",
  "pasteChunkDelayMs",
];

let config = null;
let dictationMode = "polished";
let suggestions = [];

function byId(id) {
  return document.getElementById(id);
}

function setStatus(message, kind = "") {
  const status = byId("status");
  status.textContent = message;
  status.className = kind;
}

function setDictationMode(value) {
  dictationMode = value === "fast" ? "fast" : "polished";
  document.querySelectorAll("#dictationMode button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === dictationMode);
  });
}

function numberValue(id) {
  const value = Number(byId(id).value);
  return Number.isFinite(value) ? value : undefined;
}

function renderConfig(nextConfig) {
  config = nextConfig;
  fields.forEach((field) => {
    const element = byId(field);
    if (element && config[field] !== undefined) {
      element.value = config[field];
    }
  });
  setDictationMode(config.dictationMode);
  renderTerms(config.dictionaryTerms || []);
  setStatus("Loaded", "ok");
}

function renderTerms(terms) {
  const root = byId("terms");
  root.innerHTML = "";
  if (!terms.length) {
    const empty = document.createElement("span");
    empty.textContent = "No terms";
    empty.style.color = "var(--muted)";
    empty.style.fontSize = "12px";
    root.appendChild(empty);
    return;
  }

  terms.forEach((term) => {
    const pill = document.createElement("div");
    pill.className = "term";

    const label = document.createElement("span");
    label.textContent = term;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "x";
    remove.title = `Remove ${term}`;
    remove.addEventListener("click", async () => {
      try {
        const terms = await window.electronAPI.removeDictionaryTerm(term);
        renderTerms(terms);
        setStatus("Dictionary saved", "ok");
      } catch (error) {
        setStatus(error.message || "Remove failed", "error");
      }
    });

    pill.append(label, remove);
    root.appendChild(pill);
  });
}

function renderSuggestions(nextSuggestions) {
  suggestions = nextSuggestions || [];
  const root = byId("suggestions");
  root.innerHTML = "";
  if (!suggestions.length) {
    return;
  }

  suggestions.forEach((term) => {
    const pill = document.createElement("div");
    pill.className = "term";

    const label = document.createElement("span");
    label.textContent = term;

    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "+";
    add.title = `Add ${term}`;
    add.addEventListener("click", async () => {
      try {
        const terms = await window.electronAPI.addDictionaryTerm(term);
        renderTerms(terms);
        renderSuggestions(suggestions.filter((item) => item !== term));
        setStatus("Dictionary saved", "ok");
      } catch (error) {
        setStatus(error.message || "Add failed", "error");
      }
    });

    pill.append(label, add);
    root.appendChild(pill);
  });
}

async function load() {
  try {
    renderConfig(await window.electronAPI.getRuntimeConfig());
  } catch (error) {
    setStatus(error.message || "Load failed", "error");
  }
}

async function save() {
  const payload = {
    shortcut: byId("shortcut").value.trim(),
    commandShortcut: byId("commandShortcut").value.trim(),
    model: byId("model").value.trim(),
    textModel: byId("textModel").value.trim(),
    dictationMode,
    timeoutMs: numberValue("timeoutMs"),
    previewIntervalMs: numberValue("previewIntervalMs"),
    doneHideWindowMs: numberValue("doneHideWindowMs"),
    polishChunkWords: numberValue("polishChunkWords"),
    polishMaxWords: numberValue("polishMaxWords"),
    pasteChunkChars: numberValue("pasteChunkChars"),
    pasteChunkDelayMs: numberValue("pasteChunkDelayMs"),
  };

  try {
    renderConfig(await window.electronAPI.updateRuntimeSettings(payload));
    setStatus("Saved", "ok");
  } catch (error) {
    setStatus(error.message || "Save failed", "error");
  }
}

async function resetSettings() {
  try {
    renderConfig(await window.electronAPI.resetRuntimeSettings());
    setStatus("Reset", "ok");
  } catch (error) {
    setStatus(error.message || "Reset failed", "error");
  }
}

async function addTerm() {
  const input = byId("dictionaryTerm");
  const term = input.value.trim();
  if (!term) return;

  try {
    const terms = await window.electronAPI.addDictionaryTerm(term);
    input.value = "";
    renderTerms(terms);
    setStatus("Dictionary saved", "ok");
  } catch (error) {
    setStatus(error.message || "Add failed", "error");
  }
}

async function suggestTerms() {
  try {
    renderSuggestions(await window.electronAPI.suggestDictionaryTerms());
    setStatus(suggestions.length ? "Suggestions loaded" : "No suggestions", suggestions.length ? "ok" : "");
  } catch (error) {
    setStatus(error.message || "Suggest failed", "error");
  }
}

async function addSuggestions() {
  if (!suggestions.length) {
    await suggestTerms();
  }
  if (!suggestions.length) return;

  try {
    let terms = config?.dictionaryTerms || [];
    for (const suggestion of suggestions) {
      terms = await window.electronAPI.addDictionaryTerm(suggestion);
    }
    renderTerms(terms);
    renderSuggestions([]);
    setStatus("Suggestions added", "ok");
  } catch (error) {
    setStatus(error.message || "Add suggestions failed", "error");
  }
}

async function testMic() {
  let stream = null;
  let audioContext = null;
  try {
    setStatus("Testing mic");
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 256;
    const data = new Uint8Array(analyser.frequencyBinCount);

    let detected = false;
    for (let i = 0; i < 16; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      analyser.getByteFrequencyData(data);
      const average = data.reduce((sum, value) => sum + value, 0) / data.length;
      if (average > 10) detected = true;
    }

    setStatus(detected ? "Mic working" : "No audio detected", detected ? "ok" : "error");
  } catch (error) {
    setStatus(`${microphoneStatusForError(error)}: ${formatError(error)}`, "error");
  } finally {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close().catch(() => {});
    }
  }
}

document.querySelectorAll("#dictationMode button").forEach((button) => {
  button.addEventListener("click", () => setDictationMode(button.dataset.mode));
});

byId("save").addEventListener("click", save);
byId("reload").addEventListener("click", load);
byId("reset").addEventListener("click", resetSettings);
byId("addTerm").addEventListener("click", addTerm);
byId("suggestTerms").addEventListener("click", suggestTerms);
byId("addSuggestions").addEventListener("click", addSuggestions);
byId("testMic").addEventListener("click", testMic);
byId("dictionaryTerm").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    addTerm();
  }
});

load();
