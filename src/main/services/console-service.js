const net = require("net");

class ConsoleService {
  constructor({ runtimeSettings, applySettings, setupShortcut, diagnostics, logger, mainWindow, app, transcriptionService }) {
    this.runtimeSettings = runtimeSettings;
    this.applySettings = applySettings;
    this.setupShortcut = setupShortcut;
    this.diagnostics = diagnostics;
    this.logger = logger;
    this.mainWindow = mainWindow;
    this.app = app;
    this.transcriptionService = transcriptionService;
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
    if (cmd === "devices") return this._cmdDevices();
    if (cmd === "set") return this._cmdSet(parts.slice(1));
    if (cmd === "refresh" && parts[1]?.toLowerCase() === "mic") return this._cmdRefreshMic();
    if (cmd === "test" && parts[1]?.toLowerCase() === "mic") return this._cmdTestMic();
    if (cmd === "recovery") return this._cmdRecovery();
    if (cmd === "retry") return this._cmdRetry(parts.slice(1));

    this._sendLine(`  Unknown command: ${input}`);
    this._sendLine(`  Type "help" for available commands.`);
  }

  _cmdHelp() {
    const kv = (cmd, desc) => `  ${cmd.padEnd(26)} ${desc}`;
    const lines = [
      "",
      kv("status", "Show current config"),
      kv("set model <name>", "Change transcription model"),
      kv("set hotkey <combo>", "Change global shortcut"),
      kv("set injection <mode>", "deferred | blocking | off"),
      kv("set profile <name>", "fast | balanced"),
      kv("set timeslice <ms>", "Recorder timeslice (min 50)"),
      kv("set restore-delay <ms>", "Clipboard restore delay"),
      kv("refresh mic", "Refresh microphone"),
      kv("test mic", "Test microphone levels"),
      kv("devices", "List audio inputs"),
      kv("perf", "Performance stats"),
      kv("recovery", "List saved recordings"),
      kv("retry <filename>", "Re-transcribe a recovery file"),
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
      kv("Hotkey", s.shortcut),
      kv("Injection", s.clipboardRestoreMode),
      kv("Restore Delay", `${s.clipboardRestoreDelayMs}ms`),
      kv("Timeslice", `${s.recorderTimesliceMs}ms`),
      kv("Timeout", `${s.timeoutMs}ms`),
      kv("Max Queue", String(s.maxQueue)),
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

    if (key === "hotkey") {
      this.applySettings({ shortcut: value });
      this.setupShortcut();
      this._sendLine(`  Hotkey -> ${this.runtimeSettings.shortcut}`);
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
        fast: { model: "whisper-large-v3-turbo", clipboardRestoreMode: "off", recorderTimesliceMs: 100 },
        balanced: { model: "whisper-large-v3", clipboardRestoreMode: "deferred", recorderTimesliceMs: 150 },
      };
      const profile = profiles[value.toLowerCase()];
      if (!profile) {
        this._sendLine("  Invalid profile. Use: fast | balanced");
        return;
      }
      this.applySettings(profile);
      this._sendLine(`  Profile "${value}" applied`);
      this._sendLine(`  model=${this.runtimeSettings.model}  injection=${this.runtimeSettings.clipboardRestoreMode}  timeslice=${this.runtimeSettings.recorderTimesliceMs}ms`);
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
    this._sendLine(`  Recovery files (${files.length}):`);
    for (const f of files) {
      const sizeMB = (f.size / (1024 * 1024)).toFixed(1);
      const date = f.modified.toISOString().replace("T", " ").slice(0, 19);
      this._sendLine(`  ${f.name}  ${sizeMB}MB  ${date}`);
    }
    this._sendLine("");
    this._sendLine('  Use "retry <filename>" to re-transcribe.');
    this._sendLine("");
  }

  async _cmdRetry(args) {
    if (!this.transcriptionService) {
      this._sendLine("  Transcription service not available.");
      return;
    }
    if (!args.length) {
      this._sendLine('  Usage: retry <filename>');
      this._sendLine('  Run "recovery" to see available files.');
      return;
    }
    const filename = args[0];
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
