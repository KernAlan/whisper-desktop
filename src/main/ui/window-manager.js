const { BrowserWindow, Menu, screen } = require("electron");
const path = require("path");

class WindowManager {
  constructor({ hideWindowMs }) {
    this.hideWindowMs = hideWindowMs;
    this.mainWindow = null;
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

  createMenu(onQuit) {
    const template = [
      {
        label: "File",
        submenu: [
          { label: "Show App", click: () => this.mainWindow?.show() },
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
    const { workArea } = screen.getPrimaryDisplay();
    this.mainWindow.setPosition(workArea.x + workArea.width - 380, workArea.y + workArea.height - 320);
    this.mainWindow.showInactive();
    if (autoHide) {
      this.scheduleHide();
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

