const net = require("net");
const { clipboard } = require("electron");

class ConsoleService {
  constructor({
    runtimeSettings,
    applySettings,
    setupShortcut,
    diagnostics,
    logger,
    mainWindow,
    app,
    transcriptionService,
    transcriptStore,
    dictionaryService,
    wakeWordService,
    openSettings,
    resetSettings,
  }) {
    this.runtimeSettings = runtimeSettings;
    this.applySettings = applySettings;
    this.setupShortcut = setupShortcut;
    this.diagnostics = diagnostics;
    this.logger = logger;
    this.mainWindow = mainWindow;
    this.app = app;
    this.transcriptionService = transcriptionService;
    this.transcriptStore = transcriptStore || null;
    this.dictionaryService = dictionaryService;
    this.wakeWordService = wakeWordService || null;
    this.openSettings = typeof openSettings === "function" ? openSettings : null;
    this.resetSettings = typeof resetSettings === "function" ? resetSettings : null;
    this._conn = null;
    this._buffer = "";
    this._oneshot = false;
  }

  start() {
    const pipeName = process.env.WHISPER_PIPE || (
      process.platform === "win32"
        ? "\\\\.\\pipe\\whisper-desktop-console"
        : "/tmp/whisper-desktop-console.sock"
    );

    this._server = net.createServer((conn) => {
      this._conn = conn;
      this._oneshot = false;
      this._bannerSent = false;

      conn.on("data", (data) => {
        this._buffer += data.toString();
        let idx;
        while ((idx = this._buffer.indexOf("\n")) !== -1) {
          const line = this._buffer.slice(0, idx).replace(/\r$/, "");
          this._buffer = this._buffer.slice(idx + 1);
          const trimmed = line.trim();
          if (trimmed === "__oneshot__") {
            this._oneshot = true;
            continue;
          }
          if (!this._bannerSent && !this._oneshot) {
            this._sendBanner();
            this._bannerSent = true;
          }
          this._handleCommand(trimmed);
        }
      });

      conn.on("error", () => {
        this._conn = null;
      });

      conn.on("close", () => {
        this._conn = null;
      });
    });

    this._server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        this.logger.warn("[Console] pipe in use — another instance may be running. CLI disabled.");
        return;
      }
      this.logger.error("[Console] pipe error:", err.message);
    });

    this._server.listen(pipeName);

    this.diagnostics.setTranscriptListener((entry) => this._pushTranscript(entry));
  }

  _send(text) {
    if (this._conn && !this._conn.destroyed) {
      this._conn.write(text);
    }
  }

  _sendLine(text) {
    this._send(text + "\n");
    if (this._oneshot && this._conn && !this._conn.destroyed) {
      this._conn.end();
    }
  }

  _sendBanner() {
    this._sendLine("");
    this._sendLine("  Type help for commands.");
    this._sendLine("");
  }

  _pushTranscript(entry) {
    if (!this._conn || this._conn.destroyed || this._oneshot) return;
    const paste = entry.pasteOk === true ? "ok" : entry.pasteOk === false ? "FAIL" : "n/a";
    const preview = entry.text.length > 60
      ? entry.text.slice(0, 57) + "..."
      : entry.text;
    this._send(`\n  [transcript] ${entry.text.length} chars | paste: ${paste} | ${preview}\n`);
  }

  setMainWindow(win) {
    this.mainWindow = win;
  }

  _handleCommand(input) {
    if (!input) return;

    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === "help") return this._cmdHelp();
    if (cmd === "status") return this._cmdStatus();
    if (cmd === "quit" || cmd === "exit") return this._cmdQuit();
    if (cmd === "perf") return this._cmdPerf();
    if (cmd === "settings") return this._cmdSettings();
    if (cmd === "reset" && parts[1]?.toLowerCase() === "settings") return this._cmdResetSettings();
    if (cmd === "devices") return this._cmdDevices();
    if (cmd === "set") return this._cmdSet(parts.slice(1));
    if (cmd === "refresh" && parts[1]?.toLowerCase() === "mic") return this._cmdRefreshMic();
    if (cmd === "test" && parts[1]?.toLowerCase() === "mic") return this._cmdTestMic();
    if (cmd === "last") return this._cmdLast(parts.slice(1));
    if (cmd === "copy-last" || (cmd === "copy" && parts[1]?.toLowerCase() === "last")) {
      return this._cmdCopyLast();
    }
    if (cmd === "last-command") return this._cmdLastCommand();
    if (cmd === "history") return this._cmdHistory();
    if (cmd === "recovery") return this._cmdRecovery();
    if (cmd === "retry") return this._cmdRetry(parts.slice(1));
    if (cmd === "dict") return this._cmdDictionary(parts.slice(1));

    this._sendLine(`  Unknown command: ${input}`);
    this._sendLine(`  Type "help" for available commands.`);
  }

  _cmdHelp() {
    const kv = (cmd, desc) => `  ${cmd.padEnd(26)} ${desc}`;
    const lines = [
      "",
      kv("status", "Show current config"),
      kv("set model <name>", "Change transcription model"),
      kv("set text-model <name>", "Change cleanup/command text model"),
      kv("set dictation <mode>", "fast | polished"),
      kv("set wake <on|off>", "Enable or disable local wake phrase"),
      kv("set hotkey <combo>", "Change global shortcut"),
      kv("set command-hotkey <combo>", "Change command-mode shortcut"),
      kv("set injection <mode>", "deferred | blocking | off"),
      kv("set profile <name>", "fast | balanced"),
      kv("set timeslice <ms>", "Recorder timeslice (min 50)"),
      kv("set preview <ms>", "Initial preview delay (min 1000)"),
      kv("set timeout <ms>", "Transcription timeout (min 3000)"),
      kv("set restore-delay <ms>", "Clipboard restore delay"),
      kv("refresh mic", "Refresh microphone"),
      kv("test mic", "Test microphone levels"),
      kv("devices", "List audio inputs"),
      kv("perf", "Performance stats"),
      kv("settings", "Open settings window"),
      kv("reset settings", "Reset saved settings to .env/defaults"),
      kv("last [n]", "Show last N transcriptions (default 1)"),
      kv("copy-last", "Copy latest saved transcript to clipboard"),
      kv("last-command", "Show last command-mode run"),
      kv("history", "List recent transcriptions"),
      kv("dict", "List dictionary terms"),
      kv("dict suggest", "Suggest terms from recent transcripts"),
      kv("dict add-suggested [n]", "Add suggested terms"),
      kv("dict add <term>", "Add a dictionary term"),
      kv("dict remove <term>", "Remove a dictionary term"),
      kv("recovery", "List saved recordings"),
      kv("retry <latest|file|session>", "Re-transcribe saved audio"),
      kv("quit", "Exit"),
      "",
    ];
    this._sendLine(lines.join("\n"));
  }

  _cmdStatus() {
    const s = this.runtimeSettings;
    const kv = (label, value) => `  ${label.padEnd(18)} ${value}`;
    const lines = [
      "",
      kv("Model", s.model),
      kv("Fallback", s.fallbackModel),
      kv("Text Model", s.textModel),
      kv("Dictation", s.dictationMode),
      kv("Polish Chunks", `${s.polishChunkWords} words`),
      kv("Polish Max", `${s.polishMaxWords} words`),
      kv("Hotkey", s.shortcut),
      kv("Command Hotkey", s.commandShortcut),
      kv("Injection", s.clipboardRestoreMode),
      kv("Restore Delay", `${s.clipboardRestoreDelayMs}ms`),
      kv("Timeslice", `${s.recorderTimesliceMs}ms`),
      kv("Preview", `${s.previewIntervalMs}ms`),
      kv("Done Hide", `${s.doneHideWindowMs}ms`),
      kv("Paste Chunks", `${s.pasteChunkChars} chars`),
      kv("Paste Delay", `${s.pasteChunkDelayMs}ms`),
      kv("Timeout", `${s.timeoutMs}ms`),
      kv("Max Queue", String(s.maxQueue)),
      kv("Dictionary", `${this.dictionaryService?.list?.().length || 0} terms`),
      kv("Wake Phrase", this.runtimeSettings.wakePhraseEnabled ? "on (Hey Whisper)" : "off"),
      "",
    ];
    this._sendLine(lines.join("\n"));
  }

  _cmdQuit() {
    this._sendLine("  Shutting down...");
    this.app.quit();
  }

  _cmdPerf() {
    const d = this.diagnostics;
    const fmt = (samples, label) => {
      if (!samples.length) return `  ${label.padEnd(18)} --`;
      const p50 = Math.round(d.percentile(samples, 50));
      const p95 = Math.round(d.percentile(samples, 95));
      return `  ${label.padEnd(18)} n=${samples.length}  p50=${p50}ms  p95=${p95}ms`;
    };
    const lines = [
      "",
      fmt(d.pipelineSamples, "Pipeline"),
      fmt(d.transcribeSamples, "Transcribe"),
      fmt(d.preprocessSamples, "Preprocess"),
      fmt(d.pasteSamples, "Paste"),
      "",
    ];
    this._sendLine(lines.join("\n"));
  }

  _cmdSet(args) {
    if (args.length < 2) {
      this._sendLine('  Usage: set <key> <value>');
      return;
    }

    const key = args[0].toLowerCase();
    const value = args.slice(1).join(" ");

    if (key === "model") {
      this.applySettings({ model: value });
      this._sendLine(`  Model -> ${this.runtimeSettings.model}`);
      return;
    }

    if (key === "text-model") {
      this.applySettings({ textModel: value });
      this._sendLine(`  Text model -> ${this.runtimeSettings.textModel}`);
      return;
    }

    if (key === "dictation" || key === "dictation-mode") {
      if (!["fast", "polished"].includes(value)) {
        this._sendLine("  Invalid dictation mode. Use: fast | polished");
        return;
      }
      this.applySettings({ dictationMode: value });
      this._sendLine(`  Dictation -> ${this.runtimeSettings.dictationMode}`);
      return;
    }

    if (key === "wake" || key === "wake-phrase") {
      const normalized = value.toLowerCase();
      if (!["on", "off", "true", "false", "1", "0"].includes(normalized)) {
        this._sendLine("  Wake phrase must be on or off");
        return;
      }
      const enabled = ["on", "true", "1"].includes(normalized);
      this.applySettings({ wakePhraseEnabled: enabled });
      this._sendLine(`  Wake phrase -> ${enabled ? "on (Hey Whisper)" : "off"}`);
      return;
    }

    if (key === "hotkey") {
      this.applySettings({ shortcut: value });
      this.setupShortcut();
      this._sendLine(`  Hotkey -> ${this.runtimeSettings.shortcut}`);
      return;
    }

    if (key === "command-hotkey") {
      this.applySettings({ commandShortcut: value });
      this.setupShortcut();
      this._sendLine(`  Command hotkey -> ${this.runtimeSettings.commandShortcut}`);
      return;
    }

    if (key === "injection") {
      if (!["deferred", "blocking", "off"].includes(value)) {
        this._sendLine("  Invalid mode. Use: deferred | blocking | off");
        return;
      }
      this.applySettings({ clipboardRestoreMode: value });
      this._sendLine(`  Injection -> ${this.runtimeSettings.clipboardRestoreMode}`);
      return;
    }

    if (key === "profile") {
      const profiles = {
        fast: {
          model: "whisper-large-v3-turbo",
          clipboardRestoreMode: "off",
          recorderTimesliceMs: 100,
          dictationMode: "fast",
        },
        balanced: {
          model: "whisper-large-v3",
          clipboardRestoreMode: "deferred",
          recorderTimesliceMs: 150,
          dictationMode: "polished",
        },
      };
      const profile = profiles[value.toLowerCase()];
      if (!profile) {
        this._sendLine("  Invalid profile. Use: fast | balanced");
        return;
      }
      this.applySettings(profile);
      this._sendLine(`  Profile "${value}" applied`);
      this._sendLine(`  model=${this.runtimeSettings.model}  dictation=${this.runtimeSettings.dictationMode}  injection=${this.runtimeSettings.clipboardRestoreMode}  timeslice=${this.runtimeSettings.recorderTimesliceMs}ms`);
      return;
    }

    if (key === "timeslice") {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms < 50) {
        this._sendLine("  Timeslice must be >= 50");
        return;
      }
      this.applySettings({ recorderTimesliceMs: ms });
      this._sendLine(`  Timeslice -> ${this.runtimeSettings.recorderTimesliceMs}ms`);
      return;
    }

    if (key === "preview") {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms < 1000) {
        this._sendLine("  Preview delay must be >= 1000");
        return;
      }
      this.applySettings({ previewIntervalMs: ms });
      this._sendLine(`  Preview -> ${this.runtimeSettings.previewIntervalMs}ms`);
      return;
    }

    if (key === "timeout") {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms < 3000) {
        this._sendLine("  Timeout must be >= 3000");
        return;
      }
      this.applySettings({ timeoutMs: ms });
      this._sendLine(`  Timeout -> ${this.runtimeSettings.timeoutMs}ms`);
      return;
    }

    if (key === "restore-delay") {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0) {
        this._sendLine("  Restore delay must be > 0");
        return;
      }
      this.applySettings({ clipboardRestoreDelayMs: ms });
      this._sendLine(`  Restore delay -> ${this.runtimeSettings.clipboardRestoreDelayMs}ms`);
      return;
    }

    this._sendLine(`  Unknown setting: ${key}`);
  }

  _cmdRefreshMic() {
    if (!this.mainWindow) {
      this._sendLine("  No window available.");
      return;
    }
    this._sendLine("  Refreshing microphone...");
    this.mainWindow.webContents.send("refresh-mic");
  }

  _cmdTestMic() {
    if (!this.mainWindow) {
      this._sendLine("  No window available.");
      return;
    }
    this._sendLine("  Testing microphone (2s)...");
    this.mainWindow.webContents.send("test-mic");
  }

  _cmdDevices() {
    if (!this.mainWindow) {
      this._sendLine("  No window available.");
      return;
    }
    this._sendLine("  Requesting device list...");
    this.mainWindow.webContents.send("list-devices");
  }

  _cmdLast(args) {
    const n = Math.max(1, Math.min(50, Number(args[0]) || 1));
    const entries = this.diagnostics.getTranscriptHistory(n);
    if (!entries.length) {
      return this._cmdLastFromStore(n);
    }
    this._sendLine("");
    for (const entry of entries) {
      const date = new Date(entry.timestamp).toLocaleTimeString();
      const paste = entry.pasteOk === true ? "ok" : entry.pasteOk === false ? "FAIL" : "n/a";
      this._sendLine(`  [${date}] (${entry.text.length} chars, paste: ${paste})`);
      this._sendLine(`  ${entry.text}`);
      this._sendLine("");
    }
  }

  _cmdHistory() {
    const entries = this.diagnostics.getTranscriptHistory();
    if (!entries.length) {
      this._sendLine("  No transcriptions yet.");
      return;
    }
    this._sendLine("");
    this._sendLine(`  Transcriptions (${entries.length}):`);
    for (const entry of entries) {
      const date = new Date(entry.timestamp).toLocaleTimeString();
      const paste = entry.pasteOk === true ? "ok" : entry.pasteOk === false ? "FAIL" : "n/a";
      const preview = entry.text.length > 60
        ? entry.text.slice(0, 57) + "..."
        : entry.text;
      this._sendLine(`  ${date}  ${String(entry.text.length).padStart(5)} chars  paste: ${paste.padEnd(4)}  ${preview}`);
    }
    this._sendLine("");
    this._sendLine('  Use "last [n]" to see full text.');
    this._sendLine("");
  }

  async _cmdRecovery() {
    if (!this.transcriptionService) {
      this._sendLine("  Transcription service not available.");
      return;
    }
    const files = await this.transcriptionService.listRecoveryFiles();
    if (!files.length) {
      this._sendLine("  No recovery files found.");
      return;
    }
    this._sendLine("");
    this._sendLine(`  Recovery (${files.length} file${files.length === 1 ? "" : "s"}):`);
    const groups = this._groupRecoveryFiles(files);
    for (const group of groups) {
      const sizeMB = (group.size / (1024 * 1024)).toFixed(1);
      const date = group.modified.toISOString().replace("T", " ").slice(0, 19);
      if (group.total > 1) {
        this._sendLine(`  ${group.sessionId}  ${group.count}/${group.total} chunks  ${sizeMB}MB  ${date}`);
      } else {
        this._sendLine(`  ${group.name}  ${sizeMB}MB  ${date}`);
      }
    }
    this._sendLine("");
    this._sendLine('  Use "retry latest", "retry <filename>", or "retry <session-id>".');
    this._sendLine("");
  }

  async _cmdLastFromStore(n) {
    if (!this.transcriptStore) {
      this._sendLine("  No transcriptions yet.");
      return;
    }
    const entries = await this.transcriptStore.list(n);
    if (!entries.length) {
      this._sendLine("  No transcriptions yet.");
      return;
    }
    this._sendLine("");
    for (const entry of entries) {
      const text = entry.text || "";
      const date = entry.modified.toLocaleTimeString();
      this._sendLine(`  [${date}] (${text.length} chars, saved)`);
      this._sendLine(`  ${text}`);
      this._sendLine("");
    }
  }

  async _cmdCopyLast() {
    if (!this.transcriptStore) {
      this._sendLine("  No transcript store available.");
      return;
    }
    const entry = await this.transcriptStore.latest();
    if (!entry?.text?.trim()) {
      this._sendLine("  No saved transcripts found.");
      return;
    }
    clipboard.writeText(entry.text);
    this._sendLine(`  Copied latest transcript (${entry.text.length} chars).`);
  }

  _groupRecoveryFiles(files) {
    const groups = new Map();
    for (const file of files) {
      const key = file.total > 1 && file.sessionId ? file.sessionId : file.name;
      const group = groups.get(key) || {
        sessionId: file.sessionId,
        name: file.name,
        total: file.total || 1,
        count: 0,
        size: 0,
        modified: file.modified,
      };
      group.count += 1;
      group.size += file.size || 0;
      if (file.modified > group.modified) group.modified = file.modified;
      groups.set(key, group);
    }
    return Array.from(groups.values()).sort((a, b) => b.modified - a.modified);
  }

  async _cmdRetry(args) {
    if (!this.transcriptionService) {
      this._sendLine("  Transcription service not available.");
      return;
    }
    if (!args.length) {
      this._sendLine('  Usage: retry <latest|filename|session-id>');
      this._sendLine('  Run "recovery" to see available files.');
      return;
    }
    let filename = args[0];
    if (filename.toLowerCase() === "latest") {
      const files = await this.transcriptionService.listRecoveryFiles();
      if (!files.length) {
        this._sendLine("  No recovery files found.");
        return;
      }
      filename = files[0].name;
    }
    this._sendLine(`  Retrying ${filename}...`);
    try {
      const text = await this.transcriptionService.retryRecoveryFile(filename);
      if (!text || !text.trim()) {
        this._sendLine("  Transcription returned empty text.");
        return;
      }
      this._sendLine(`  Transcription (${text.length} chars):`);
      this._sendLine(`  ${text.slice(0, 500)}${text.length > 500 ? "..." : ""}`);
      // Attempt to paste if window is available
      if (this.mainWindow) {
        this.mainWindow.webContents.send("retry-paste", text);
        this._sendLine("  Text sent to app for pasting.");
      }
    } catch (err) {
      this._sendLine(`  Retry failed: ${err.message}`);
    }
  }

  _cmdLastCommand() {
    const entry = this.diagnostics.getLastCommand();
    if (!entry) {
      this._sendLine("  No command-mode runs yet.");
      return;
    }
    const date = new Date(entry.timestamp).toLocaleTimeString();
    const paste = entry.pasteOk === true ? "ok" : entry.pasteOk === false ? "FAIL" : "n/a";
    this._sendLine("");
    this._sendLine(`  [${date}] selected=${entry.selectedChars} selectionOk=${entry.selectionOk} output=${entry.outputChars} paste=${paste}`);
    this._sendLine(`  ${entry.instruction}`);
    this._sendLine("");
  }

  _cmdSettings() {
    if (!this.openSettings) {
      this._sendLine("  Settings window is not available.");
      return;
    }
    this.openSettings();
    this._sendLine("  Settings opened.");
  }

  _cmdResetSettings() {
    if (!this.resetSettings) {
      this._sendLine("  Reset settings is not available.");
      return;
    }
    this.resetSettings();
    this._sendLine("  Settings reset to defaults.");
  }

  async _cmdDictionary(args) {
    if (!this.dictionaryService) {
      this._sendLine("  Dictionary service not available.");
      return;
    }

    const action = args[0]?.toLowerCase();
    const term = args.slice(1).join(" ").trim();
    try {
      if (action === "suggest") {
        const suggestions = this.diagnostics.suggestDictionaryTerms(this.dictionaryService.list());
        if (!suggestions.length) {
          this._sendLine("  No suggestions from recent transcripts.");
          return;
        }
        this._sendLine("");
        this._sendLine(`  Suggestions (${suggestions.length}):`);
        suggestions.forEach((item, index) => this._sendLine(`  ${index + 1}. ${item}`));
        this._sendLine("");
        this._sendLine('  Use "dict add-suggested [n]" to add them.');
        this._sendLine("");
        return;
      }

      if (action === "add-suggested") {
        const limit = Math.max(1, Math.min(25, Number(args[1]) || 12));
        const suggestions = this.diagnostics.suggestDictionaryTerms(
          this.dictionaryService.list(),
          limit
        );
        if (!suggestions.length) {
          this._sendLine("  No suggestions to add.");
          return;
        }
        for (const suggestion of suggestions) {
          await this.dictionaryService.add(suggestion);
        }
        this._sendLine(`  Added ${suggestions.length} suggested term(s).`);
        return;
      }

      if (action === "add") {
        await this.dictionaryService.add(term);
        this._sendLine(`  Added dictionary term: ${term}`);
        return;
      }
      if (action === "remove" || action === "rm") {
        await this.dictionaryService.remove(term);
        this._sendLine(`  Removed dictionary term: ${term}`);
        return;
      }

      const terms = this.dictionaryService.list();
      if (!terms.length) {
        this._sendLine("  Dictionary is empty.");
        return;
      }
      this._sendLine("");
      this._sendLine(`  Dictionary (${terms.length}):`);
      terms.forEach((item) => this._sendLine(`  - ${item}`));
      this._sendLine("");
    } catch (error) {
      this._sendLine(`  Dictionary error: ${error.message}`);
    }
  }

  handleIpcResult(channel, data) {
    if (channel === "refresh-mic-result") {
      if (data.ok) {
        this._sendLine(`  Mic refreshed: ${data.label || "unknown"}`);
      } else {
        this._sendLine(`  Mic refresh failed: ${data.error || "unknown error"}`);
      }
    } else if (channel === "test-mic-result") {
      if (data.detected) {
        this._sendLine("  Mic working - audio detected");
      } else if (data.error) {
        this._sendLine(`  Mic test failed: ${data.error}`);
      } else {
        this._sendLine("  No audio detected - check microphone");
      }
    } else if (channel === "list-devices-result") {
      if (!data.devices || !data.devices.length) {
        this._sendLine("  No audio devices found.");
        return;
      }
      this._sendLine("");
      this._sendLine(`  Audio devices (${data.devices.length}):`);
      data.devices.forEach((d, i) => {
        this._sendLine(`  ${i + 1}. ${(d.label || d.deviceId || "unknown").slice(0, 70)}`);
      });
      this._sendLine("");
    }
  }
}

module.exports = { ConsoleService };
