#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_PLUGIN_ID,
  inferPluginIdFromConfig,
  inferVaultPathFromConfig,
  parseConfig,
  resolveAdbPath,
  run,
  runAdbShell,
  selectAndroidDevice,
  shellQuote,
} from "./utils.mjs";
import {
  REQUIRED_PLUGIN_ARTIFACTS,
  assertProductionPluginArtifacts,
  buildProductionPlugin,
} from "../../../../scripts/plugin-artifacts.mjs";

const REQUIRED_FILES = REQUIRED_PLUGIN_ARTIFACTS;
const OPTIONAL_FILES = ["README.md", "LICENSE", "versions.json"];

function usage() {
  console.log(`Usage: node testing/native/device/android/sync-plugin.mjs [options]

Push the built plugin artifacts into an Obsidian vault on a connected Android
device or emulator.

Options:
  --config, -c <path>     Use a custom Android sync config. Default: ./systemsculpt-sync.android.json
  --serial <id>           adb serial to target. Auto-selects if only one device is present.
  --vault-path <path>     Android shared-storage vault path. Overrides config.
  --plugin-id <id>        Plugin id. Default: systemsculpt-ai
  --skip-build            Reuse the current artifact set without running npm run build first.
  --help, -h              Show this help.`);
}

function fail(message) {
  console.error(`[android-sync] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    serial: null,
    vaultPath: null,
    pluginId: DEFAULT_PLUGIN_ID,
    build: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config" || arg === "-c") {
      options.configPath = path.resolve(process.cwd(), argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (arg === "--serial") {
      options.serial = String(argv[index + 1] || "").trim() || null;
      index += 1;
      continue;
    }
    if (arg === "--vault-path") {
      options.vaultPath = String(argv[index + 1] || "").trim() || null;
      index += 1;
      continue;
    }
    if (arg === "--plugin-id") {
      options.pluginId = String(argv[index + 1] || "").trim() || DEFAULT_PLUGIN_ID;
      index += 1;
      continue;
    }
    if (arg === "--skip-build") {
      options.build = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }

    fail(`Unknown argument: ${arg}`);
  }

  return options;
}

function ensureAndroidReadyArtifacts({ build }) {
  try {
    if (build) {
      console.log("[android-sync] Building production plugin artifacts");
      return buildProductionPlugin({ root: process.cwd() });
    }

    console.log("[android-sync] Verifying existing production plugin artifacts");
    return assertProductionPluginArtifacts({ root: process.cwd() });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

const options = parseArgs(process.argv.slice(2));
const config = parseConfig(options.configPath);
const vaultPath = options.vaultPath || inferVaultPathFromConfig(config);
if (!vaultPath) {
  fail("Missing vault path. Set vaultPath in config or pass --vault-path.");
}

const pluginId = options.pluginId || inferPluginIdFromConfig(config) || DEFAULT_PLUGIN_ID;
const pluginPath = `${vaultPath.replace(/\/$/, "")}/.obsidian/plugins/${pluginId}`;
const artifactInspection = ensureAndroidReadyArtifacts({ build: options.build });

const adbPath = resolveAdbPath();
const device = selectAndroidDevice({
  adbPath,
  serial: options.serial || config?.adbSerial || null,
  preferEmulator: true,
});

console.log(`[android-sync] Target device: ${device.serial}`);
console.log(`[android-sync] Vault path: ${vaultPath}`);
console.log(`[android-sync] Plugin path: ${pluginPath}`);
console.log(`[android-sync] main.js size: ${artifactInspection.mainBundle.formattedSize}`);

runAdbShell(
  adbPath,
  device.serial,
  `rm -rf ${shellQuote(pluginPath)} && mkdir -p ${shellQuote(pluginPath)}`,
);

for (const file of REQUIRED_FILES.concat(OPTIONAL_FILES)) {
  const sourcePath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(sourcePath)) {
    continue;
  }
  run(adbPath, ["-s", device.serial, "push", sourcePath, `${pluginPath}/${path.basename(file)}`]);
  console.log(`[android-sync] Pushed ${file}`);
}

console.log("[android-sync] Android plugin sync complete.");
