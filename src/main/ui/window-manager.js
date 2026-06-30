const { BrowserWindow, Menu, screen } = require("electron");
const path = require("path");

class WindowManager {
  constructor({ hideWindowMs }) {
    this.hideWindowMs = hideWindowMs;
    this.mainWindow = null;
    this.settingsWindow = null;
    this.hideTimer = null;
  }

  createMainWindow() {
    const preloadPath = path.join(__dirname, "..", "..", "preload", "preload.js");
    this.mainWindow = new BrowserWindow({
      width: 360,
      height: 300,
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

    this.mainWindow.webContents.session.setPermissionCheckHandler(
      (_webContents, permission) => permission === "media"
    );
    this.mainWindow.webContents.session.setPermissionRequestHandler(
      (_webContents, permission, callback) => callback(permission === "media")
    );

    this.mainWindow.loadFile(path.join(__dirname, "..", "..", "..", "index.html"));
    return this.mainWindow;
  }

  createSettingsWindow() {
    const preloadPath = path.join(__dirname, "..", "..", "preload", "preload.js");
    this.settingsWindow = new BrowserWindow({
      width: 760,
      height: 720,
      minWidth: 680,
      minHeight: 560,
      show: false,
      title: "Whisper Desktop Settings",
      backgroundColor: "#f5f2ea",
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.settingsWindow.loadFile(path.join(__dirname, "..", "..", "..", "settings.html"));
    this.settingsWindow.on("closed", () => {
      this.settingsWindow = null;
    });
    return this.settingsWindow;
  }

  showSettingsWindow() {
    if (!this.settingsWindow) {
      this.createSettingsWindow();
    }
    this.settingsWindow.once("ready-to-show", () => {
      this.settingsWindow?.show();
      this.settingsWindow?.focus();
    });
    if (!this.settingsWindow.isVisible()) {
      this.settingsWindow.show();
    }
    this.settingsWindow.focus();
  }

  createMenu({ onShowApp, onSettings, onQuit }) {
    const template = [
      {
        label: "File",
        submenu: [
          { label: "Show App", click: onShowApp },
          { label: "Settings", click: onSettings },
          { type: "separator" },
          { label: "Quit", click: onQuit },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  showWindow({ autoHide = true } = {}) {
    if (!this.mainWindow) return;
    this.cancelHide();
    this.recoverWindowState();
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore();
    }
    const { workArea } = screen.getPrimaryDisplay();
    this.mainWindow.setBounds({
      x: workArea.x + workArea.width - 380,
      y: workArea.y + workArea.height - 320,
      width: 360,
      height: 300,
    });
    this.mainWindow.showInactive();
    this.mainWindow.moveTop();
    if (autoHide) {
      this.scheduleHide();
    }
  }

  recoverWindowState() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.setSkipTaskbar(true);
    this.mainWindow.setAlwaysOnTop(false);
    this.mainWindow.setAlwaysOnTop(true);
    const { workArea } = screen.getPrimaryDisplay();
    this.mainWindow.setBounds({
      x: workArea.x + workArea.width - 380,
      y: workArea.y + workArea.height - 320,
      width: 360,
      height: 300,
    });
    if (this.mainWindow.isVisible()) {
      this.mainWindow.showInactive();
      this.mainWindow.moveTop();
    }
  }

  scheduleHide(delayMs = this.hideWindowMs) {
    this.cancelHide();
    this.hideTimer = setTimeout(() => this.hideWindow(), delayMs);
  }

  cancelHide() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  hideWindow() {
    this.cancelHide();
    this.mainWindow?.hide();
  }

  getWindow() {
    return this.mainWindow;
  }
}

module.exports = {
  WindowManager,
};

