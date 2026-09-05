const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { TrayController, DEFAULT_ICON_PATH } = require("../src/main/ui/tray-controller");

function createHarness({ platform = "win32", iconEmpty = false, appOverrides = {} } = {}) {
  const events = {};
  const state = { tooltip: "", menu: null, destroyed: false };
  const calls = { shown: 0, toggledSettings: 0, restarted: 0, quit: 0 };
  let loginItem = { openAtLogin: false };

  class FakeTray {
    constructor(icon) {
      this.icon = icon;
    }
    setToolTip(text) {
      state.tooltip = text;
    }
    setContextMenu(menu) {
      state.menu = menu;
    }
    on(event, handler) {
      events[event] = handler;
    }
    destroy() {
      state.destroyed = true;
    }
  }

  const controller = new TrayController({
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: (p) => ({ path: p, isEmpty: () => iconEmpty }) },
    app: {
      quit: () => {
        calls.quit += 1;
      },
      getLoginItemSettings: () => loginItem,
      setLoginItemSettings: (settings) => {
        loginItem = { ...settings };
      },
      ...appOverrides,
    },
    logger: { log() {}, warn() {} },
    platform,
    onShowApp: () => {
      calls.shown += 1;
    },
    onToggleSettings: () => {
      calls.toggledSettings += 1;
    },
    onRestart: () => {
      calls.restarted += 1;
    },
  });

  const item = (label) => state.menu?.find((entry) => entry.label === label);
  return { controller, state, calls, events, item, getLoginItem: () => loginItem };
}

test("the tray icon ships with the app", () => {
  const fs = require("fs");
  assert.equal(path.basename(DEFAULT_ICON_PATH), "tray-icon.png");
  assert.ok(fs.existsSync(DEFAULT_ICON_PATH), "tray icon asset is missing");
  // Guards against committing a truncated or non-PNG file.
  const signature = fs.readFileSync(DEFAULT_ICON_PATH).subarray(0, 8).toString("hex");
  assert.equal(signature, "89504e470d0a1a0a");
});

test("the tray menu exposes every control", () => {
  const { controller, state, item } = createHarness();
  controller.start();

  assert.equal(state.tooltip, "Whisper Desktop");
  for (const label of [
    "Show Whisper Desktop",
    "Settings",
    "Start on Login",
    "Restart Whisper Desktop",
    "Quit",
  ]) {
    assert.ok(item(label), `missing menu item: ${label}`);
  }
});

test("the menu items call through", () => {
  const { controller, calls, item } = createHarness();
  controller.start();

  item("Show Whisper Desktop").click();
  item("Settings").click();
  item("Restart Whisper Desktop").click();
  item("Quit").click();

  assert.deepEqual(calls, { shown: 1, toggledSettings: 1, restarted: 1, quit: 1 });
});

test("clicking the icon shows the app, except on macOS", () => {
  const windows = createHarness({ platform: "win32" });
  windows.controller.start();
  windows.events.click();
  assert.equal(windows.calls.shown, 1);

  // A macOS tray with a context menu opens the menu on click, so registering a
  // click handler there would shadow it.
  const mac = createHarness({ platform: "darwin" });
  mac.controller.start();
  assert.equal(mac.events.click, undefined);
});

test("start on login writes the setting and reflects it back", () => {
  const { controller, item, getLoginItem } = createHarness();
  controller.start();

  assert.equal(item("Start on Login").checked, false);
  item("Start on Login").click({ checked: true });
  assert.equal(getLoginItem().openAtLogin, true);
  // The menu is rebuilt from the stored setting, not from the click.
  assert.equal(item("Start on Login").checked, true);

  item("Start on Login").click({ checked: false });
  assert.equal(getLoginItem().openAtLogin, false);
  assert.equal(item("Start on Login").checked, false);
});

// Electron only implements the login item on macOS and Windows.
test("start on login is left out where the platform cannot do it", () => {
  const { controller, item } = createHarness({ platform: "linux" });
  controller.start();
  assert.equal(item("Start on Login"), undefined);
  assert.ok(item("Quit"), "the rest of the menu still builds");
});

// The tray is the only way back to a hidden, taskbar-skipping window, but a
// tray that cannot be built must not take the app down with it.
test("a failed tray is survivable", () => {
  const { controller, state } = createHarness({ iconEmpty: true });
  assert.equal(controller.start(), null);
  assert.equal(state.menu, null);
  assert.doesNotThrow(() => controller.refresh());
  assert.doesNotThrow(() => controller.destroy());
});

test("a login item that cannot be read leaves the box unchecked", () => {
  const { controller, item } = createHarness({
    appOverrides: {
      getLoginItemSettings: () => {
        throw new Error("registry unavailable");
      },
    },
  });
  controller.start();
  assert.equal(item("Start on Login").checked, false);
});

test("start is idempotent and destroy clears the tray", () => {
  const { controller, state } = createHarness();
  const first = controller.start();
  assert.equal(controller.start(), first);
  controller.destroy();
  assert.equal(state.destroyed, true);
  assert.equal(controller.tray, null);
});
