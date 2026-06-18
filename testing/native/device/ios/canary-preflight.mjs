#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  formatDeviceLabel,
  listDevicectlDevices,
  selectReachablePhysicalIosDevice,
} from "../../shared/ios-device-selection.mjs";

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "systemsculpt-sync.ios.json");

function fail(message) {
  throw new Error(message);
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    fail(`Missing value for ${flag}.`);
  }
  return value;
}

function usage() {
  console.log(`Usage: node testing/native/device/ios/canary-preflight.mjs [options]

Verify that this Mac can run the iOS canary lane before syncing or launching
Obsidian.

Options:
  --config, -c <path>  Sync config to require. Default: ./systemsculpt-sync.ios.json
  --device <id>        Device identifier, UDID, or exact name to require.
  --skip-config        Do not require the local sync config.
  --json               Print machine-readable JSON instead of a short text summary.
  --help, -h           Show this help.`);
}

export function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    requestedDevice: null,
    skipConfig: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config" || arg === "-c") {
      options.configPath = path.resolve(process.cwd(), requireValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--device") {
      options.requestedDevice = String(requireValue(argv, index, arg)).trim() || null;
      index += 1;
      continue;
    }
    if (arg === "--skip-config") {
      options.skipConfig = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    fail(`Unknown argument: ${arg}`);
  }

  return options;
}

function runText(command, args, { spawnImpl = spawnSync } = {}) {
  const result = spawnImpl(command, args, {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    fail(`${command} ${args.join(" ")} failed${output ? `: ${output}` : ""}`);
  }
  return String(result.stdout || "").trim();
}

export function commandPath(command, { spawnImpl = spawnSync } = {}) {
  return runText("bash", ["-lc", `command -v ${command}`], { spawnImpl });
}

export function readJsonFromDevicectl(
  args,
  {
    fsImpl = fs,
    osImpl = os,
    pathImpl = path,
    spawnImpl = spawnSync,
    now = () => Date.now(),
    random = () => Math.random(),
  } = {},
) {
  const tempPath = pathImpl.join(
    osImpl.tmpdir(),
    `obsidian-systemsculpt-ai-ios-canary-${now()}-${random().toString(16).slice(2)}.json`,
  );

  try {
    runText("xcrun", [...args, "--json-output", tempPath, "--quiet"], { spawnImpl });
    return JSON.parse(fsImpl.readFileSync(tempPath, "utf8"));
  } finally {
    fsImpl.rmSync(tempPath, { force: true });
  }
}

export function inspectSyncConfig(configPath, { fsImpl = fs } = {}) {
  const resolvedPath = path.resolve(process.cwd(), configPath || DEFAULT_CONFIG_PATH);
  if (!fsImpl.existsSync(resolvedPath)) {
    fail(`iOS sync config is missing: ${resolvedPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    fail(`iOS sync config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const pluginTargets = Array.isArray(parsed.pluginTargets) ? parsed.pluginTargets : [];
  if (pluginTargets.length < 1) {
    fail("iOS sync config must define at least one pluginTargets entry.");
  }

  return {
    path: resolvedPath,
    pluginTargets: pluginTargets.length,
    mirrorTargets: Array.isArray(parsed.mirrorTargets) ? parsed.mirrorTargets.length : 0,
  };
}

export function runIosCanaryPreflight(options = {}, dependencies = {}) {
  const config = options.skipConfig
    ? null
    : inspectSyncConfig(options.configPath || DEFAULT_CONFIG_PATH, dependencies);
  const xcodePath = runText("xcode-select", ["-p"], dependencies);
  const xcrunPath = commandPath("xcrun", dependencies);
  const adapterPath = commandPath("remotedebug_ios_webkit_adapter", dependencies);
  const payload = dependencies.readDevicesImpl
    ? dependencies.readDevicesImpl()
    : readJsonFromDevicectl(["devicectl", "list", "devices"], dependencies);
  const devices = listDevicectlDevices(payload);
  const device = selectReachablePhysicalIosDevice(devices, {
    requestedDevice: options.requestedDevice,
    recoveryAction: "re-run the iOS canary preflight",
  });

  return {
    ok: true,
    config,
    tools: {
      xcodePath,
      xcrunPath,
      remotedebugIosWebkitAdapterPath: adapterPath,
    },
    device: {
      label: formatDeviceLabel(device),
      identifier: String(device.identifier || "").trim(),
      udid: String(device.hardwareProperties?.udid || "").trim(),
      platform: String(device.hardwareProperties?.platform || "").trim(),
      osVersion: String(device.deviceProperties?.osVersionNumber || "").trim(),
      transportType: String(device.connectionProperties?.transportType || "").trim() || null,
      tunnelState: String(device.connectionProperties?.tunnelState || "").trim() || null,
      developerModeStatus: String(device.deviceProperties?.developerModeStatus || "").trim() || null,
    },
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const result = runIosCanaryPreflight(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("[ios-canary] Preflight passed.");
  console.log(`[ios-canary] Xcode: ${result.tools.xcodePath}`);
  console.log(`[ios-canary] WebKit adapter: ${result.tools.remotedebugIosWebkitAdapterPath}`);
  if (result.config) {
    console.log(`[ios-canary] Sync config: ${result.config.path} (${result.config.pluginTargets} plugin target(s))`);
  }
  console.log(
    `[ios-canary] Device: ${result.device.label}` +
      `${result.device.transportType ? ` via ${result.device.transportType}` : ""}`,
  );
}

const isDirectExecution = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isDirectExecution) {
  try {
    main();
  } catch (error) {
    console.error(`[ios-canary] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
