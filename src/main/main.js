const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  Menu,
  clipboard,
  screen,
  systemPreferences,
} = require("electron");
const path = require("path");
const fs = require("fs-extra");
const os = require("os");
require("dotenv").config();
const Groq = require("groq-sdk");
const ks = require("node-key-sender");

let mainWindow;

function createWindow() {
  const preloadPath = path.join(__dirname, "..", "preload", "preload.js");
  console.log("Preload script path:", preloadPath);

  mainWindow = new BrowserWindow({
    width: 300,
    height: 180,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Set permission handlers
  mainWindow.webContents.session.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) => {
      if (permission === "media") {
        return true;
      }
      return false;
    }
  );

  mainWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      if (permission === "media") {
        callback(true);
      } else {
        callback(false);
      }
    }
  );

  mainWindow.loadFile(path.join(__dirname, "..", "..", "index.html"));

  mainWindow.webContents.on(
    "console-message",
    (event, level, message, line, sourceId) => {
      console.log("Renderer Console:", message);
    }
  );

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("Window loaded, setting up global shortcut");
    setupGlobalShortcut();
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (event, errorCode, errorDescription) => {
      console.error("Failed to load:", errorCode, errorDescription);
    }
  );
}

function showWindow() {
  if (mainWindow) {
    // Get the position of the primary display
    const { workArea } = screen.getPrimaryDisplay();

    // Position the window in the bottom right corner
    mainWindow.setPosition(
      workArea.x + workArea.width - 320,
      workArea.y + workArea.height - 200
    );

    mainWindow.showInactive(); // Show without focusing

    // Automatically hide after 5 seconds (adjust as needed)
    setTimeout(() => {
      hideWindow();
    }, 5000);
  }
}

function hideWindow() {
  if (mainWindow) {
    mainWindow.hide();
  }
}

function createApplicationMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { label: "Show App", click: () => mainWindow.show() },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function setupGlobalShortcut() {
  globalShortcut.register("CommandOrControl+Shift+Space", () => {
    console.log("Shortcut triggered in main process");
    showWindow();
    const windows = BrowserWindow.getAllWindows();
    console.log(`Sending toggle-recording event to ${windows.length} windows`);
    windows.forEach((window, index) => {
      window.webContents.send("toggle-recording");
      console.log(`toggle-recording event sent to window ${index + 1}`);
    });
  });
}

app.on("ready", () => {
  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true,
  });
  createWindow();
  createApplicationMenu();
});

async function checkAndRequestMicrophonePermission() {
  if (process.platform !== "darwin") {
    return true; // For non-macOS platforms, assume permission is granted
  }

  const status = systemPreferences.getMediaAccessStatus("microphone");
  console.log("Current microphone access status:", status);

  if (status === "granted") {
    return true;
  }

  try {
    const hasAccess = await systemPreferences.askForMediaAccess("microphone");
    console.log("Microphone access granted:", hasAccess);
    return hasAccess;
  } catch (error) {
    console.error("Error requesting microphone access:", error);
    return false;
  }
}

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle("transcribe-audio", async (event, arrayBuffer) => {
  try {
    console.log(
      "Received ArrayBuffer in main process, size:",
      arrayBuffer.byteLength
    );
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    // Create a temporary file
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, "temp_audio.webm");

    // Convert ArrayBuffer to Buffer and write to the temporary file
    const buffer = Buffer.from(arrayBuffer);
    await fs.writeFile(tempFilePath, buffer);

    // Create a read stream from the temporary file
    const fileStream = fs.createReadStream(tempFilePath);

    const response = await groq.audio.transcriptions.create({
      file: fileStream,
      model: "whisper-large-v3",
      response_format: "text",
    });

    // Delete the temporary file
    await fs.unlink(tempFilePath);
    console.log("Groq API response:", response);

    if (typeof response === "string") {
      return response;
    } else if (response && response.text) {
      return response.text;
    } else {
      console.error("Unexpected response format:", response);
      return null;
    }
  } catch (error) {
    console.error("Transcription error:", error);
    throw error;
  }
});

ipcMain.handle("simulate-typing", async (event, text) => {
  try {
    // Save the current clipboard content
    const originalClipboard = clipboard.readText();

    // Copy the new text to clipboard
    clipboard.writeText(text);

    // Simulate Ctrl+V (or Cmd+V on macOS) to paste
    const modifier = process.platform === "darwin" ? "command" : "control";
    await ks.sendCombination([modifier, "v"]);

    // Restore the original clipboard content
    clipboard.writeText(originalClipboard);

    return true;
  } catch (error) {
    console.error("Error simulating typing:", error);
    return false;
  }
});

ipcMain.handle("request-microphone-access", async () => {
  const hasAccess = await checkAndRequestMicrophonePermission();
  if (hasAccess) {
    return true;
  } else {
    throw new Error("Microphone access not granted");
  }
});

ipcMain.handle("hide-window", () => {
  hideWindow();
});
