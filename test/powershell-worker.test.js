const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PowerShellWorker } = require("../src/main/services/powershell-worker");

// A stand-in for powershell.exe. It answers whatever is written to stdin, so the
// tests never have to guess when the worker has finished starting up.
function createFakeChild({ autoReply = () => null } = {}) {
  const child = new EventEmitter();
  child.killed = false;
  child.writes = [];
  child.commands = [];
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => {
    child.killed = true;
  };
  child.say = (line) => child.stdout.emit("data", `${line}\n`);
  child.stdin = {
    write(text) {
      child.writes.push(text);
      const line = text.trim();
      // The init script ends with the ready marker echo, which the worker treats
      // as any other response.
      if (line.startsWith('Write-Output "@@WD ready OK"')) {
        setImmediate(() => child.say("@@WD ready OK"));
        return;
      }
      const match = line.match(/^(.*) -Id (\S+)$/);
      if (!match) return;
      child.commands.push({ command: match[1], id: match[2] });
      const reply = autoReply(match[1], match[2], child);
      if (reply !== null && reply !== undefined) setImmediate(() => child.say(reply));
    },
  };
  return child;
}

function createWorker({ autoReply, ...overrides } = {}) {
  const children = [];
  const worker = new PowerShellWorker({
    initScript: "INIT",
    logger: { warn() {} },
    spawnProcess: () => {
      const child = createFakeChild({ autoReply });
      children.push(child);
      return child;
    },
    ...overrides,
  });
  return { worker, children };
}

test("PowerShellWorker sends the init script once and reuses the process", async () => {
  const { worker, children } = createWorker({
    autoReply: (command, id) => `@@WD ${id} OK {"windowId":"4${id}"}`,
  });

  assert.equal(await worker.run("Invoke-WDCapture"), '{"windowId":"41"}');
  assert.equal(await worker.run("Invoke-WDCapture"), '{"windowId":"42"}');

  assert.equal(children.length, 1, "the process is spawned once, not per request");
  assert.equal(children[0].writes.filter((w) => w.includes("INIT")).length, 1);
  worker.dispose();
});

test("PowerShellWorker tags each request with its own id and serializes them", async () => {
  let inFlight = 0;
  const { worker, children } = createWorker({
    autoReply: (command, id) => {
      inFlight += 1;
      assert.equal(inFlight, 1, "only one request may be in flight at a time");
      inFlight -= 1;
      return `@@WD ${id} OK`;
    },
  });

  await Promise.all([worker.run("First"), worker.run("Second")]);

  assert.deepEqual(children[0].commands, [
    { command: "First", id: "1" },
    { command: "Second", id: "2" },
  ]);
  worker.dispose();
});

test("PowerShellWorker rejects with the script's own error message", async () => {
  const { worker } = createWorker({
    autoReply: (command, id) => `@@WD ${id} ERR target-window-not-foreground`,
  });
  await assert.rejects(worker.run("Invoke-WDShortcut"), /target-window-not-foreground/);
  worker.dispose();
});

test("PowerShellWorker fails pending work and respawns after the process dies", async () => {
  const { worker, children } = createWorker({
    autoReply: (command, id, child) => {
      if (children.length === 1) {
        setImmediate(() => child.emit("exit", 1));
        return null;
      }
      return `@@WD ${id} OK recovered`;
    },
  });

  await assert.rejects(worker.run("Invoke-WDCapture"), /exited with code 1/);
  assert.equal(await worker.run("Invoke-WDCapture"), "recovered");
  assert.equal(children.length, 2, "the next call starts a fresh process");
  worker.dispose();
});

test("PowerShellWorker drops a wedged process instead of stalling every later paste", async () => {
  const { worker, children } = createWorker({
    requestTimeoutMs: 30,
    autoReply: (command, id) => (children.length === 1 ? null : `@@WD ${id} OK recovered`),
  });

  await assert.rejects(worker.run("Invoke-WDCapture"), /timed out/);
  assert.equal(children[0].killed, true, "the wedged process is killed rather than reused");
  assert.equal(await worker.run("Invoke-WDCapture"), "recovered");
  worker.dispose();
});

test("PowerShellWorker ignores stray output and reassembles a split response", async () => {
  const { worker, children } = createWorker({
    autoReply: (command, id, child) => {
      child.say("some unrelated PowerShell chatter");
      child.stdout.emit("data", `@@WD ${id} OK sp`);
      child.stdout.emit("data", "lit\n");
      return null;
    },
  });

  assert.equal(await worker.run("Invoke-WDCapture"), "split");
  worker.dispose();
});
