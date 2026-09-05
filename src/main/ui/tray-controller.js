const path = require("path");

const DEFAULT_ICON_PATH = path.join(__dirname, "..", "assets", "tray-icon.png");

// Electron only implements the login item on macOS and Windows. Everywhere else
// the menu entry is left out rather than shown doing nothing.
const LOGIN_ITEM_PLATFORMS = new Set(["darwin", "win32"]);

/**
 * The system tray icon and its menu.
 *
 * The window is frameless, always-on-top and skips the taskbar, so once it hides
 * there is nothing to click: the tray is the only way back to the app without
 * the hotkey. Everything here is therefore recovery UI, and it has to keep
 * working when the rest of the app is misbehaving -- which is why a tray that
 * fails to build is logged and swallowed rather than taking the app down with it.
 */
class TrayController {
  constructor({
    Tray,
    Menu,
    nativeImage,
    app,
    iconPath = DEFAULT_ICON_PATH,
    onShowApp,
    onToggleSettings,
    onRestart,
    logger,
    platform = process.platform,
  }) {
    this.Tray = Tray;
    this.Menu = Menu;
    this.nativeImage = nativeImage;
    this.app = app;
    this.iconPath = iconPath;
    this.onShowApp = typeof onShowApp === "function" ? onShowApp : () => {};
    this.onToggleSettings = typeof onToggleSettings === "function" ? onToggleSettings : () => {};
    this.onRestart = typeof onRestart === "function" ? onRestart : () => {};
    this.logger = logger || console;
    this.platform = platform;
    this.tray = null;
  }

  start() {
    if (this.tray) return this.tray;
    try {
      const icon = this.nativeImage.createFromPath(this.iconPath);
      if (icon.isEmpty?.()) {
        throw new Error(`Tray icon could not be read from ${this.iconPath}`);
      }
      this.tray = new this.Tray(icon);
      this.tray.setToolTip("Whisper Desktop");
      // On macOS a tray with a context menu opens it on any click, so the
      // click-to-show handler would never fire and is not registered.
      if (this.platform !== "darwin") {
        this.tray.on("click", () => this.onShowApp());
      }
      this.refresh();
      return this.tray;
    } catch (error) {
      this.tray = null;
      this.logger.warn(`[Tray] Unavailable: ${error?.message || error}`);
      return null;
    }
  }

  /** Rebuilds the menu so the login-item checkbox matches the real setting. */
  refresh() {
    if (!this.tray) return;
    try {
      this.tray.setContextMenu(this.Menu.buildFromTemplate(this.buildTemplate()));
    } catch (error) {
      this.logger.warn(`[Tray] Menu could not be built: ${error?.message || error}`);
    }
  }

  buildTemplate() {
    const template = [
      { label: "Show Whisper Desktop", click: () => this.onShowApp() },
      { label: "Settings", click: () => this.onToggleSettings() },
      { type: "separator" },
    ];

    if (this.supportsOpenAtLogin()) {
      template.push({
        label: "Start on Login",
        type: "checkbox",
        checked: this.getOpenAtLogin(),
        click: (menuItem) => this.setOpenAtLogin(menuItem.checked),
      });
      template.push({ type: "separator" });
    }

    template.push({ label: "Restart Whisper Desktop", click: () => this.onRestart() });
    template.push({ type: "separator" });
    template.push({ label: "Quit", click: () => this.app.quit() });
    return template;
  }

  supportsOpenAtLogin() {
    return LOGIN_ITEM_PLATFORMS.has(this.platform);
  }

  getOpenAtLogin() {
    try {
      return Boolean(this.app.getLoginItemSettings().openAtLogin);
    } catch (error) {
      this.logger.warn(`[Tray] Could not read the login item: ${error?.message || error}`);
      return false;
    }
  }

  setOpenAtLogin(openAtLogin) {
    const enabled = Boolean(openAtLogin);
    try {
      // openAsHidden is macOS-only and is what keeps a login start from
      // popping the window open in the user's face.
      this.app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled });
      this.logger.log(`[Tray] Start on login ${enabled ? "enabled" : "disabled"}.`);
    } catch (error) {
      this.logger.warn(`[Tray] Could not change the login item: ${error?.message || error}`);
    }
    // Read the setting back rather than trusting the click: if the write above
    // failed, the checkbox must fall back to what is actually true.
    this.refresh();
  }

  destroy() {
    try {
      this.tray?.destroy();
    } catch (error) {
      this.logger.warn(`[Tray] Could not be destroyed: ${error?.message || error}`);
    }
    this.tray = null;
  }
}

module.exports = {
  TrayController,
  DEFAULT_ICON_PATH,
};
