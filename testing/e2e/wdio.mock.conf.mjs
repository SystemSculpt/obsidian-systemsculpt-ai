import path from "node:path";
import { fileURLToPath } from "node:url";
import ObsidianReporter from "wdio-obsidian-reporter";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const maxInstances = Number(process.env.SYSTEMSCULPT_E2E_INSTANCES || 2);
const appVersion = process.env.SYSTEMSCULPT_E2E_APP_VERSION || "1.11.7";

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
