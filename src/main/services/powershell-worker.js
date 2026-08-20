const { spawn } = require("node:child_process");

// Every Windows paste used to spawn a powershell.exe and run Add-Type on a C#
// source string, which invokes the C# compiler at runtime. Measured on a warm
// machine: 154ms for bare PowerShell startup, 250ms once Add-Type is included.
// That ran on the critical path of every single dictation. This worker pays the
// cost once and then answers each request over stdin in single-digit ms.
const MARKER = "@@WD";
const DEFAULT_REQUEST_TIMEOUT_MS = 4000;
const DEFAULT_START_TIMEOUT_MS = 8000;

class PowerShellWorker {
  constructor({ initScript, spawnProcess = spawn, logger, requestTimeoutMs, startTimeoutMs } = {}) {
    this.initScript = String(initScript || "");
    this.spawnProcess = spawnProcess;
    this.logger = logger || console;
    this.requestTimeoutMs = Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
    this.startTimeoutMs = Number.isFinite(startTimeoutMs) ? startTimeoutMs : DEFAULT_START_TIMEOUT_MS;

    this.child = null;
    this.starting = null;
    this.stdoutBuffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.queue = Promise.resolve();
    this.disposed = false;
  }

  // Starts the worker without making the caller wait. Used at app startup so the
  // first paste of the session is as fast as the rest.
  warmUp() {
    this._ensureStarted().catch((error) => {
      this.logger.warn?.(`[PowerShell] Warm-up failed: ${error.message}`);
    });
  }

  // Requests are serialized. Sending keystrokes to a foreground window is not
  // safe to interleave, and it keeps the stdout protocol trivial to reason about.
  run(command) {
    const next = this.queue.then(
      () => this._run(command),
      () => this._run(command)
    );
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  async _run(command) {
    if (this.disposed) throw new Error("PowerShell worker has been disposed");
    const child = await this._ensureStarted();
    const id = String(this.nextId++);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A wedged worker never recovers on its own, and every later paste would
        // inherit the same stall. Drop it and let the next call start a fresh one.
        this._teardown(new Error("PowerShell worker timed out"));
        reject(new Error(`PowerShell request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      try {
        child.stdin.write(`${command} -Id ${id}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  _ensureStarted() {
    if (this.child && !this.child.killed) return Promise.resolve(this.child);
    if (this.starting) return this.starting;

    this.starting = new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnProcess(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", "-"],
          { windowsHide: true }
        );
      } catch (error) {
        this.starting = null;
        reject(error);
        return;
      }

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => this._onStdout(chunk));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) this.logger.warn?.(`[PowerShell] ${text}`);
      });
      child.on("error", (error) => this._teardown(error));
      child.on("exit", (code) => this._teardown(new Error(`PowerShell worker exited with code ${code}`)));

      this.child = child;

      const readyTimer = setTimeout(() => {
        this.starting = null;
        this._teardown(new Error("PowerShell worker did not become ready"));
        reject(new Error(`PowerShell worker did not start within ${this.startTimeoutMs}ms`));
      }, this.startTimeoutMs);

      // The init script ends by echoing a ready marker, so the promise resolves
      // only once Add-Type has actually finished compiling.
      const readyId = "ready";
      this.pending.set(readyId, {
        resolve: () => {
          clearTimeout(readyTimer);
          this.starting = null;
          resolve(child);
        },
        reject: (error) => {
          clearTimeout(readyTimer);
          this.starting = null;
          reject(error);
        },
      });

      try {
        child.stdin.write(`${this.initScript}\n`);
        child.stdin.write(`Write-Output "${MARKER} ${readyId} OK"\n`);
      } catch (error) {
        clearTimeout(readyTimer);
        this.pending.delete(readyId);
        this.starting = null;
        reject(error);
      }
    });

    return this.starting;
  }

  _onStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.startsWith(MARKER)) this._settle(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  _settle(line) {
    // "@@WD <id> OK [payload]" or "@@WD <id> ERR <message>"
    const parts = line.slice(MARKER.length).trim().split(/\s+/);
    const id = parts.shift();
    const status = parts.shift();
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    const payload = line.slice(line.indexOf(status) + status.length).trim();
    if (status === "OK") waiter.resolve(payload);
    else waiter.reject(new Error(payload || "PowerShell command failed"));
  }

  _teardown(error) {
    const child = this.child;
    this.child = null;
    this.stdoutBuffer = "";
    const waiters = Array.from(this.pending.values());
    this.pending.clear();
    for (const waiter of waiters) waiter.reject(error);
    if (child && !child.killed) {
      try {
        child.kill();
      } catch (_error) {
        // The process is already gone; nothing to clean up.
      }
    }
  }

  dispose() {
    this.disposed = true;
    this._teardown(new Error("PowerShell worker disposed"));
  }
}

module.exports = {
  PowerShellWorker,
  MARKER,
};
