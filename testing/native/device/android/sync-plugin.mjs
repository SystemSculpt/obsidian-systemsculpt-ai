#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_PLUGIN_ID,
  DEFAULT_PACKAGE_ID,
  inferPluginIdFromConfig,
  inferPackageIdFromConfig,
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
  --vault-path <path>     Android vault path. Overrides config.
  --plugin-id <id>        Plugin id. Default: systemsculpt-ai
  --package-id <id>       Android package id. Default: md.obsidian
  --reset-vault           Remove and recreate the configured vault before syncing.
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
    packageId: DEFAULT_PACKAGE_ID,
    resetVault: false,
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
    if (arg === "--package-id") {
      options.packageId = String(argv[index + 1] || "").trim() || DEFAULT_PACKAGE_ID;
      index += 1;
      continue;
    }
    if (arg === "--reset-vault") {
      options.resetVault = true;
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
const packageId = options.packageId || inferPackageIdFromConfig(config) || DEFAULT_PACKAGE_ID;
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

if (options.resetVault) {
  console.log("[android-sync] Resetting Android QA vault");
  runAdbShell(adbPath, device.serial, `am force-stop ${shellQuote(packageId)} || true`);
  runAdbShell(
    adbPath,
    device.serial,
    `rm -rf ${shellQuote(vaultPath)} && mkdir -p ${shellQuote(pluginPath)}`
  );
} else {
  runAdbShell(
    adbPath,
    device.serial,
    `mkdir -p ${shellQuote(`${vaultPath.replace(/\/$/, "")}/.obsidian/plugins`)} && rm -rf ${shellQuote(pluginPath)} && mkdir -p ${shellQuote(pluginPath)}`
  );
}

runAdbShell(
  adbPath,
  device.serial,
  `printf %s ${shellQuote(JSON.stringify([pluginId]))} > ${shellQuote(`${vaultPath.replace(/\/$/, "")}/.obsidian/community-plugins.json`)}`
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
