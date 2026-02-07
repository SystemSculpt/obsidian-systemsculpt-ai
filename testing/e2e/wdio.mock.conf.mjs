import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import ObsidianReporter from "wdio-obsidian-reporter";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isMac = process.platform === "darwin";
const maxInstances = Number(process.env.SYSTEMSCULPT_E2E_INSTANCES || 2);
const appVersion = process.env.SYSTEMSCULPT_E2E_APP_VERSION || "1.11.7";
const focusGuardEnabled = process.env.SYSTEMSCULPT_E2E_FOCUS_GUARD
  ? process.env.SYSTEMSCULPT_E2E_FOCUS_GUARD === "1"
  : isMac;
const OSASCRIPT_TIMEOUT_MS = 5_000;

export const config = {
  runner: "local",
  specs: [path.join(__dirname, "specs-mock/*.mock.e2e.ts")],
  exclude: [],
  maxInstances: Number.isFinite(maxInstances) && maxInstances > 0 ? Math.floor(maxInstances) : 2,
  logLevel: "warn",
  bail: 0,
  baseUrl: "",
  waitforTimeout: 20000,
  connectionRetryTimeout: 180000,
  connectionRetryCount: 2,

  services: [
    [
      "obsidian",
      {
        obsidianOptions: {
          plugins: [path.resolve(__dirname, "..", "..")],
          vault: path.join(__dirname, "fixtures", "vault"),
          emulateMobile: false,
          appVersion,
          cleanPlugins: true,
        },
      },
    ],
  ],

  reporters: [
    "spec",
    [
      ObsidianReporter,
      {
        outputDir: path.join(__dirname, "logs"),
      },
    ],
  ],

  before: async () => {
    captureFrontmostApp();
    await backgroundObsidianWindow();
    restoreFrontmostApp();
    if (focusGuardEnabled) startFocusGuard();
  },
  beforeTest: async () => {
    captureFrontmostApp();
    await backgroundObsidianWindow();
    restoreFrontmostApp();
  },
  afterTest: async () => {
    captureFrontmostApp();
    await backgroundObsidianWindow();
    restoreFrontmostApp();
  },
  after: async () => {
    if (focusGuardEnabled) stopFocusGuard();
  },

  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 120000,
  },

  autoCompileOpts: {
    tsNodeOpts: {
      project: path.join(__dirname, "tsconfig.json"),
      transpileOnly: true,
    },
  },

  capabilities: [
    {
      browserName: "obsidian",
      "wdio:obsidianOptions": {
        mobileEmulation: false,
      },
    },
  ],
};

let lastFrontmostApp = null;
let focusGuardTimer = null;

function getFrontmostApp() {
  if (!isMac) return null;
  try {
    const result = execSync(
      'osascript -e \'tell application "System Events" to get name of first application process whose frontmost is true\'',
      { stdio: ["ignore", "pipe", "ignore"], timeout: OSASCRIPT_TIMEOUT_MS }
    ).toString();
    return result.trim() || null;
  } catch (_) {
    return null;
  }
}

function focusApp(appName) {
  if (!isMac || !appName) return;
  const safeName = String(appName).replace(/\"/g, '\\"');
  try {
    execSync(
      `osascript -e 'tell application \"System Events\" to set frontmost of process \"${safeName}\" to true'`,
      { stdio: ["ignore", "ignore", "ignore"], timeout: OSASCRIPT_TIMEOUT_MS }
    );
  } catch (_) {}
}

function hideObsidian() {
  if (!isMac) return;
  try {
    execSync('osascript -e \'tell application "Obsidian" to hide\'', {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: OSASCRIPT_TIMEOUT_MS,
    });
  } catch (_) {}
}

function captureFrontmostApp() {
  const name = getFrontmostApp();
  if (name && name !== "Obsidian") {
    lastFrontmostApp = name;
  }
}

function restoreFrontmostApp() {
  const current = getFrontmostApp();
  if (current === "Obsidian" && lastFrontmostApp) {
    focusApp(lastFrontmostApp);
  }
}

function startFocusGuard() {
  if (!isMac || focusGuardTimer) return;
  focusGuardTimer = setInterval(() => {
    const current = getFrontmostApp();
    if (!current) return;
    if (current !== "Obsidian") {
      lastFrontmostApp = current;
      return;
    }
    hideObsidian();
    if (lastFrontmostApp) focusApp(lastFrontmostApp);
  }, 50);
}

function stopFocusGuard() {
  if (focusGuardTimer) {
    clearInterval(focusGuardTimer);
    focusGuardTimer = null;
  }
}

async function backgroundObsidianWindow() {
  try {
    await browser.execute(() => {
      try {
        const win = (window)?.electron?.remote?.getCurrentWindow?.();
        if (!win) return;
        if (typeof win.setSkipTaskbar === "function") win.setSkipTaskbar(true);
        if (typeof win.setFocusable === "function") win.setFocusable(false);
        if (typeof win.setAlwaysOnTop === "function") win.setAlwaysOnTop(false);
        if (typeof win.setVisibleOnAllWorkspaces === "function") {
          win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        }
        if (typeof win.setPosition === "function") win.setPosition(-10000, -10000, false);
        if (typeof win.blur === "function") win.blur();
        const app = (window)?.electron?.remote?.app;
        if (app?.dock && typeof app.dock.hide === "function") app.dock.hide();
      } catch (_) {}
    });
  } catch (_) {}
}

