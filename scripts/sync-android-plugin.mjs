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
} from "./android-utils.mjs";

const REQUIRED_FILES = [
  "manifest.json",
  "main.js",
  "styles.css",
  "studio-terminal-sidecar.cjs",
];
const OPTIONAL_FILES = ["README.md", "LICENSE", "versions.json"];

function usage() {
  console.log(`Usage: node scripts/sync-android-plugin.mjs [options]

Push the built plugin artifacts into an Obsidian vault on a connected Android
device or emulator.

Options:
  --config, -c <path>     Use a custom Android sync config. Default: ./systemsculpt-sync.android.json
  --serial <id>           adb serial to target. Auto-selects if only one device is present.
  --vault-path <path>     Android shared-storage vault path. Overrides config.
  --plugin-id <id>        Plugin id. Default: systemsculpt-ai
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
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }

    fail(`Unknown argument: ${arg}`);
  }

  return options;
}

function assertBuiltArtifacts() {
  for (const file of REQUIRED_FILES) {
    const sourcePath = path.resolve(process.cwd(), file);
    if (!fs.existsSync(sourcePath)) {
      fail(`Missing built artifact: ${file}. Run npm run build first.`);
    }
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
assertBuiltArtifacts();

const adbPath = resolveAdbPath();
const device = selectAndroidDevice({
  adbPath,
  serial: options.serial || config?.adbSerial || null,
  preferEmulator: true,
});

console.log(`[android-sync] Target device: ${device.serial}`);
console.log(`[android-sync] Vault path: ${vaultPath}`);
console.log(`[android-sync] Plugin path: ${pluginPath}`);

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
