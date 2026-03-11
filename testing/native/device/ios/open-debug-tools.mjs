#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "systemsculpt-sync.ios.json");
const DEFAULT_BUNDLE_ID = "md.obsidian";

function usage() {
  console.log(`Usage: node testing/native/device/ios/open-debug-tools.mjs [options]

Verified helper for the local iPad debugging lane. It can sync the latest plugin
into the configured iCloud vault, relaunch Obsidian on the connected device, and
open the Mac-side tools we actually use for diagnosis.

Options:
  --config, -c <path>     Sync config to inspect. Default: ./systemsculpt-sync.ios.json
  --device <id>           Device identifier, UDID, or exact name to target.
  --bundle-id <id>        App bundle id to launch. Default: md.obsidian
  --vault <name>          Vault name for obsidian://open. Inferred from config when possible.
  --sync                  Run sync:local before relaunching.
  --skip-relaunch         Skip the devicectl app relaunch.
  --skip-open-apps        Skip opening QuickTime, Console, and Safari.
  --open-xcode            Also open Xcode for device logs / Devices and Simulators.
  --help, -h              Show this help.`);
}

function fail(message) {
  console.error(`[ios-debug] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    const details = stderr || stdout || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${details}`);
  }

  return result;
}

function commandExists(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
  });
  return result.status === 0;
}

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    device: null,
    bundleId: DEFAULT_BUNDLE_ID,
    vaultName: null,
    sync: false,
    relaunch: true,
    openApps: true,
    openXcode: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config" || arg === "-c") {
      options.configPath = path.resolve(process.cwd(), argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (arg === "--device") {
      options.device = String(argv[index + 1] || "").trim() || null;
      index += 1;
      continue;
    }
    if (arg === "--bundle-id") {
      options.bundleId = String(argv[index + 1] || "").trim() || DEFAULT_BUNDLE_ID;
      index += 1;
      continue;
    }
    if (arg === "--vault") {
      options.vaultName = String(argv[index + 1] || "").trim() || null;
      index += 1;
      continue;
    }
    if (arg === "--sync") {
      options.sync = true;
      continue;
    }
    if (arg === "--skip-relaunch") {
      options.relaunch = false;
      continue;
    }
    if (arg === "--skip-open-apps") {
      options.openApps = false;
      continue;
    }
    if (arg === "--open-xcode") {
      options.openXcode = true;
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

function inferVaultNameFromConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return null;
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);
  const pluginTargets = Array.isArray(parsed.pluginTargets) ? parsed.pluginTargets : [];
  for (const target of pluginTargets) {
    if (!target || typeof target.path !== "string") {
      continue;
    }
    const parts = target.path.split(path.sep).filter(Boolean);
    const documentsIndex = parts.indexOf("Documents");
    if (documentsIndex >= 0 && parts.length > documentsIndex + 1) {
      return parts[documentsIndex + 1];
    }
  }

  return null;
}

function readJsonFromDevicectl(args) {
  const tempPath = path.join(
    os.tmpdir(),
    `obsidian-systemsculpt-ai-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );

  try {
    run("xcrun", [...args, "--json-output", tempPath, "--quiet"]);
    return JSON.parse(fs.readFileSync(tempPath, "utf8"));
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

function selectDevice(devices, requestedDevice) {
  const candidates = devices.filter((device) => {
    const platform = device.hardwareProperties?.platform;
    const reality = device.hardwareProperties?.reality;
    const pairingState = device.connectionProperties?.pairingState;
    return platform === "iOS" && reality === "physical" && pairingState === "paired";
  });

  if (requestedDevice) {
    const lowered = requestedDevice.toLowerCase();
    const matched = candidates.find((device) => {
      const name = String(device.deviceProperties?.name || "").toLowerCase();
      const identifier = String(device.identifier || "").toLowerCase();
      const udid = String(device.hardwareProperties?.udid || "").toLowerCase();
      return name === lowered || identifier === lowered || udid === lowered;
    });
    if (!matched) {
      fail(`No paired physical iOS device matched "${requestedDevice}".`);
    }
    return matched;
  }

  const wiredCandidates = candidates.filter((device) => device.connectionProperties?.transportType === "wired");
  if (wiredCandidates.length === 1) {
    return wiredCandidates[0];
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (wiredCandidates.length > 1) {
    fail("Multiple wired iOS devices are connected. Re-run with --device.");
  }
  if (candidates.length > 1) {
    fail("Multiple iOS devices are paired. Re-run with --device.");
  }

  fail("No paired physical iOS device is currently available.");
}

function appExists(appName) {
  const result = spawnSync("open", ["-Ra", appName], { encoding: "utf8" });
  return result.status === 0;
}

function openApp(appName) {
  run("open", ["-a", appName], { stdio: "ignore" });
}

function syncPlugin(configPath) {
  console.log(`[ios-debug] Syncing latest plugin files with ${configPath}`);
  const result = spawnSync("npm", ["run", "sync:local", "--", "--strict", "--config", configPath], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    fail("Plugin sync failed.");
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!commandExists("xcrun")) {
    fail("xcrun is not available.");
  }

  const vaultName = options.vaultName || inferVaultNameFromConfig(options.configPath);
  if (options.relaunch && !vaultName) {
    fail("Could not infer the vault name. Pass --vault or provide a sync config with an Obsidian iCloud target.");
  }

  const devicesJson = readJsonFromDevicectl(["devicectl", "list", "devices"]);
  const device = selectDevice(devicesJson.result?.devices || [], options.device);
  const deviceIdentifier = String(device.identifier || "").trim();
  const deviceName = device.deviceProperties?.name || device.hardwareProperties?.marketingName || deviceIdentifier;
  const deviceUdid = device.hardwareProperties?.udid || "";
  const transport = device.connectionProperties?.transportType || "unknown";
  const osVersion = device.deviceProperties?.osVersionNumber || "unknown";

  console.log(`[ios-debug] Using device: ${deviceName}`);
  console.log(`[ios-debug] CoreDevice id: ${deviceIdentifier}`);
  console.log(`[ios-debug] UDID: ${deviceUdid}`);
  console.log(`[ios-debug] Transport: ${transport}`);
  console.log(`[ios-debug] OS: iOS ${osVersion}`);
  console.log(`[ios-debug] Developer Mode: ${device.deviceProperties?.developerModeStatus || "unknown"}`);

  const lockStateJson = readJsonFromDevicectl([
    "devicectl",
    "device",
    "info",
    "lockState",
    "--device",
    deviceIdentifier,
  ]);
  const unlockedSinceBoot = lockStateJson.result?.unlockedSinceBoot === true;
  const passcodeRequired = lockStateJson.result?.passcodeRequired === true;
  console.log(`[ios-debug] Unlocked since boot: ${unlockedSinceBoot ? "yes" : "no"}`);
  console.log(`[ios-debug] Passcode required right now: ${passcodeRequired ? "yes" : "no"}`);

  if (options.sync) {
    syncPlugin(options.configPath);
  }

  if (options.relaunch) {
    const payloadUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}`;
    const launchJson = readJsonFromDevicectl([
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      deviceIdentifier,
      "--terminate-existing",
      "--payload-url",
      payloadUrl,
      options.bundleId,
    ]);
    const launchedProcessId = launchJson.result?.process?.processIdentifier ?? "unknown";
    console.log(`[ios-debug] Relaunched ${options.bundleId} with pid ${launchedProcessId}`);
    console.log(`[ios-debug] Payload URL: ${payloadUrl}`);
  }

  if (options.openApps) {
    openApp("QuickTime Player");
    openApp("Console");

    if (appExists("Safari Technology Preview")) {
      openApp("Safari Technology Preview");
      console.log("[ios-debug] Opened Safari Technology Preview for the latest Web Inspector surface.");
    } else {
      openApp("Safari");
      console.log("[ios-debug] Safari Technology Preview is not installed, so Safari was opened instead.");
    }

    if (options.openXcode) {
      openApp("Xcode");
      console.log("[ios-debug] Opened Xcode.");
    }
  }

  console.log("[ios-debug] Next: use QuickTime for live screen mirroring, Console for device logs, and Safari Develop for Web Inspector if Obsidian exposes inspectable web content.");
}

main();
