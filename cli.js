const { spawn } = require("child_process");
const net = require("net");
const readline = require("readline");

const PIPE_NAME = process.platform === "win32"
  ? "\\\\.\\pipe\\whisper-desktop-console"
  : "/tmp/whisper-desktop-console.sock";

const args = process.argv.slice(2);

// --- One-shot mode: send command to running instance and exit ---
if (args.length > 0) {
  const command = args.join(" ");
  const conn = net.createConnection(PIPE_NAME, () => {
    conn.write("__oneshot__\n" + command + "\n");
  });

  let gotData = false;
  conn.on("data", (data) => {
    gotData = true;
    process.stdout.write(data.toString());
  });

  conn.on("end", () => {
    process.exit(0);
  });

  conn.on("error", () => {
    console.error("Not running. Start with: npm start");
    process.exit(1);
  });

  // Give the server time to respond, then disconnect
  // Retry commands need longer timeout for transcription
  const timeoutMs = command.startsWith("retry") ? 60000 : 2000;
  setTimeout(() => {
    conn.end();
    process.exit(gotData ? 0 : 1);
  }, timeoutMs);

  return;
}

// --- Interactive mode: launch Electron + REPL ---
const electronBin = require("electron");
const electronProc = spawn(String(electronBin), ["."], {
  cwd: __dirname,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, WHISPER_PIPE: PIPE_NAME },
});

electronProc.on("exit", (code) => {
  process.exit(code || 0);
});

let conn = null;
let connected = false;

function connectPipe(retries) {
  const attempt = net.createConnection(PIPE_NAME, () => {
    connected = true;
    conn = attempt;
    startRepl();
  });

  attempt.on("data", (data) => {
    process.stdout.write(data.toString());
  });

  attempt.on("error", () => {
    if (!connected && retries > 0) {
      setTimeout(() => connectPipe(retries - 1), 300);
    } else if (!connected) {
      console.error("Could not connect to console pipe.");
    }
  });

  attempt.on("close", () => {
    if (connected) {
      if (electronProc && !electronProc.killed) electronProc.kill();
      process.exit(0);
    }
  });
}

function startRepl() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "whisper> ",
  });

  rl.prompt();

  rl.on("line", (line) => {
    if (conn && !conn.destroyed) {
      conn.write(line + "\n");
    }
    rl.prompt();
  });

  rl.on("close", () => {
    if (conn && !conn.destroyed) conn.end();
    if (electronProc && !electronProc.killed) electronProc.kill();
    process.exit(0);
  });
}

// --- Clean shutdown on Ctrl+C ---
process.on("SIGINT", () => {
  if (conn && !conn.destroyed) conn.end();
  if (electronProc && !electronProc.killed) electronProc.kill();
  process.exit(0);
});

connectPipe(20);
