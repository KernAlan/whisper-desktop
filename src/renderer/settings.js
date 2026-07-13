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

const MIC_TEST_DURATION_MS = 5000;
const MIC_TEST_PEAK_THRESHOLD = 0.04;
const RESET_CONFIRM_TIMEOUT_MS = 4000;

let config = null;
let dictationMode = "polished";
let suggestions = [];
let micTestRunning = false;
let resetArmed = false;
let resetArmTimer = null;
let toastTimer = null;

function byId(id) {
  return document.getElementById(id);
}

function setStatus(message, kind = "") {
  const status = byId("status");
  status.textContent = message;
  status.className = kind;
}

function showToast(message, kind = "") {
  const toast = byId("toast");
  toast.textContent = message;
  toast.className = kind ? `show ${kind}` : "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = toast.className.replace("show", "").trim();
  }, 2600);
}

async function withBusy(button, busyLabel, action) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  try {
    return await action();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function setDictationMode(value) {
  dictationMode = value === "fast" ? "fast" : "polished";
  document.querySelectorAll("#dictationMode button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === dictationMode);
  });
  updateDirtyState();
}

function numberValue(id) {
  const value = Number(byId(id).value);
  return Number.isFinite(value) ? value : undefined;
}

function isDirty() {
  if (!config) return false;
  for (const field of fields) {
    const element = byId(field);
    if (!element) continue;
    const saved = config[field] === undefined || config[field] === null ? "" : String(config[field]);
    if (element.value.trim() !== saved.trim()) return true;
  }
  if (dictationMode !== (config.dictationMode === "fast" ? "fast" : "polished")) return true;
  if (byId("wakePhraseEnabled").checked !== Boolean(config.wakePhraseEnabled)) return true;
  return false;
}

function updateDirtyState() {
  const dirty = isDirty();
  const saveState = byId("saveState");
  saveState.textContent = dirty ? "Unsaved changes" : "All changes saved";
  saveState.classList.toggle("dirty", dirty);
  byId("save").disabled = !dirty;
  byId("reload").disabled = !dirty;
}

function renderConfig(nextConfig) {
  config = nextConfig;
  fields.forEach((field) => {
    const element = byId(field);
    if (element && config[field] !== undefined) {
      element.value = config[field];
    }
  });
  const wakePhrase = byId("wakePhraseEnabled");
  if (wakePhrase) wakePhrase.checked = Boolean(config.wakePhraseEnabled);
  setDictationMode(config.dictationMode);
  renderCredentialStatus(config.credential);
  renderTerms(config.dictionaryTerms || []);
  updateDirtyState();
  setStatus("");
}

function renderCredentialStatus(credential = {}) {
  const status = byId("credentialStatus");
  const hint = byId("credentialHint");
  const saveButton = byId("saveApiKey");
  const clearButton = byId("clearApiKey");
  const configured = Boolean(credential.configured);
  const source = credential.source === "environment" ? "environment variable" : "secure storage";

  status.textContent = configured ? `Connected via ${source}` : "Not configured";
  status.classList.toggle("connected", configured);
  saveButton.disabled = credential.secureStorageAvailable === false;
  clearButton.disabled = !configured || credential.source !== "secure storage";

  if (credential.secureStorageAvailable === false) {
    hint.textContent = "Secure credential storage is unavailable. Set GROQ_API_KEY in the environment.";
    hint.className = "hint error";
  } else {
    hint.textContent = "Keys are encrypted with the operating system credential store.";
    hint.className = "hint";
  }
}

function renderTerms(terms) {
  const root = byId("terms");
  root.replaceChildren();
  if (!terms.length) {
    const empty = document.createElement("span");
    empty.textContent = "No terms yet.";
    empty.style.color = "var(--faint)";
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
    remove.textContent = "✕";
    remove.title = `Remove ${term}`;
    remove.addEventListener("click", async () => {
      try {
        const nextTerms = await window.electronAPI.removeDictionaryTerm(term);
        if (config) config.dictionaryTerms = nextTerms;
        renderTerms(nextTerms);
        showToast(`Removed "${term}"`);
      } catch (error) {
        showToast(error.message || "Remove failed", "error");
      }
    });

    pill.append(label, remove);
    root.appendChild(pill);
  });
}

function renderSuggestions(nextSuggestions) {
  suggestions = nextSuggestions || [];
  const root = byId("suggestions");
  root.replaceChildren();
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
        if (config) config.dictionaryTerms = terms;
        renderTerms(terms);
        renderSuggestions(suggestions.filter((item) => item !== term));
        showToast(`Added "${term}"`);
      } catch (error) {
        showToast(error.message || "Add failed", "error");
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
    wakePhraseEnabled: byId("wakePhraseEnabled")?.checked === true,
  };

  try {
    await withBusy(byId("save"), "Saving…", async () => {
      renderConfig(await window.electronAPI.updateRuntimeSettings(payload));
    });
    updateDirtyState();
    showToast("Settings saved");
    const saved = config || {};
    if (saved.shortcutOk === false) {
      showToast("Saved, but the dictation hotkey could not be registered", "error");
    } else if (saved.commandShortcutOk === false) {
      showToast("Saved, but the command hotkey could not be registered", "error");
    }
  } catch (error) {
    showToast(error.message || "Save failed", "error");
  }
}

function disarmReset() {
  resetArmed = false;
  clearTimeout(resetArmTimer);
  resetArmTimer = null;
  const button = byId("reset");
  button.classList.remove("danger-armed");
  button.textContent = "Reset to Defaults";
}

async function resetSettings() {
  const button = byId("reset");
  if (!resetArmed) {
    resetArmed = true;
    button.classList.add("danger-armed");
    button.textContent = "Click again to confirm";
    resetArmTimer = setTimeout(disarmReset, RESET_CONFIRM_TIMEOUT_MS);
    return;
  }

  disarmReset();
  try {
    await withBusy(button, "Resetting…", async () => {
      renderConfig(await window.electronAPI.resetRuntimeSettings());
    });
    updateDirtyState();
    showToast("Settings reset to defaults");
  } catch (error) {
    showToast(error.message || "Reset failed", "error");
  }
}

async function discardChanges() {
  await load();
  showToast("Changes discarded");
}

async function saveApiKey() {
  const input = byId("apiKey");
  const apiKey = input.value.trim();
  if (!apiKey) {
    showToast("Enter an API key first", "error");
    input.focus();
    return;
  }

  try {
    await withBusy(byId("saveApiKey"), "Saving…", async () => {
      renderCredentialStatus(await window.electronAPI.saveApiKey(apiKey));
    });
    input.value = "";
    showToast("API key saved — speech service connected");
  } catch (error) {
    showToast(error.message || "Key save failed", "error");
  }
}

async function clearApiKey() {
  try {
    renderCredentialStatus(await window.electronAPI.clearApiKey());
    byId("apiKey").value = "";
    showToast("Saved key cleared");
  } catch (error) {
    showToast(error.message || "Key clear failed", "error");
  }
}

async function addTerm() {
  const input = byId("dictionaryTerm");
  const term = input.value.trim();
  if (!term) return;

  try {
    const terms = await window.electronAPI.addDictionaryTerm(term);
    if (config) config.dictionaryTerms = terms;
    input.value = "";
    renderTerms(terms);
    showToast(`Added "${term}"`);
  } catch (error) {
    showToast(error.message || "Add failed", "error");
  }
}

async function suggestTerms() {
  try {
    await withBusy(byId("suggestTerms"), "Analyzing…", async () => {
      renderSuggestions(await window.electronAPI.suggestDictionaryTerms());
    });
    showToast(suggestions.length ? `${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"} found` : "No suggestions found");
    if (suggestions.length) {
      byId("suggestions").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  } catch (error) {
    showToast(error.message || "Suggest failed", "error");
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
    if (config) config.dictionaryTerms = terms;
    renderTerms(terms);
    renderSuggestions([]);
    showToast("All suggestions added");
  } catch (error) {
    showToast(error.message || "Add suggestions failed", "error");
  }
}

async function testMic() {
  if (micTestRunning) return;
  micTestRunning = true;
  const button = byId("testMic");
  const fill = byId("micMeterFill");
  const result = byId("micResult");
  button.disabled = true;
  button.textContent = "Listening…";
  result.textContent = "Speak now — watch the meter.";
  result.className = "";

  let stream = null;
  let audioContext = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const deviceLabel = stream.getAudioTracks()[0]?.label || "";
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    audioContext.createMediaStreamSource(stream).connect(analyser);
    analyser.fftSize = 1024;
    const data = new Uint8Array(analyser.fftSize);

    let peak = 0;
    const endAt = Date.now() + MIC_TEST_DURATION_MS;
    while (Date.now() < endAt) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      analyser.getByteTimeDomainData(data);
      let framePeak = 0;
      for (const value of data) {
        const amplitude = Math.abs(value - 128) / 128;
        if (amplitude > framePeak) framePeak = amplitude;
      }
      if (framePeak > peak) peak = framePeak;
      fill.style.width = `${Math.min(100, framePeak * 250).toFixed(0)}%`;
    }

    if (peak > MIC_TEST_PEAK_THRESHOLD) {
      result.textContent = `Microphone working${deviceLabel ? ` — ${deviceLabel}` : ""}.`;
      result.className = "ok";
    } else {
      result.textContent = "No audio detected. Check the input device and Windows microphone privacy settings.";
      result.className = "error";
    }
  } catch (error) {
    result.textContent = `${microphoneStatusForError(error)} (${formatError(error)})`;
    result.className = "error";
  } finally {
    fill.style.width = "0%";
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close().catch(() => {});
    }
    button.disabled = false;
    button.textContent = "Test Microphone";
    micTestRunning = false;
  }
}

document.querySelectorAll("#dictationMode button").forEach((button) => {
  button.addEventListener("click", () => setDictationMode(button.dataset.mode));
});

fields.forEach((field) => {
  byId(field)?.addEventListener("input", updateDirtyState);
});
byId("wakePhraseEnabled").addEventListener("change", updateDirtyState);

byId("save").addEventListener("click", save);
byId("reload").addEventListener("click", discardChanges);
byId("reset").addEventListener("click", resetSettings);
byId("addTerm").addEventListener("click", addTerm);
byId("suggestTerms").addEventListener("click", suggestTerms);
byId("addSuggestions").addEventListener("click", addSuggestions);
byId("testMic").addEventListener("click", testMic);
byId("saveApiKey").addEventListener("click", saveApiKey);
byId("clearApiKey").addEventListener("click", clearApiKey);
byId("apiKey").addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveApiKey();
});
byId("dictionaryTerm").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    addTerm();
  }
});
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!byId("save").disabled) save();
  }
});

load();
