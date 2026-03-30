#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const DEFAULT_ANDROID_SDK_ROOT = path.join(os.homedir(), "Library/Android/sdk");
export const DEFAULT_PACKAGE_ID = "md.obsidian";
export const DEFAULT_PLUGIN_ID = "systemsculpt-ai";
export const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "systemsculpt-sync.android.json");

function commandResult(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
}

export function fail(message) {
  console.error(`[android] ${message}`);
  process.exit(1);
}

export function resolveAndroidSdkRoot() {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    DEFAULT_ANDROID_SDK_ROOT,
    "/opt/homebrew/share/android-commandlinetools",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  return path.resolve(DEFAULT_ANDROID_SDK_ROOT);
}

export function buildAndroidEnv() {
  const sdkRoot = resolveAndroidSdkRoot();
  const pathEntries = [
    "/opt/homebrew/opt/openjdk@21/bin",
    "/opt/homebrew/bin",
    path.join(sdkRoot, "platform-tools"),
    path.join(sdkRoot, "emulator"),
    process.env.PATH || "",
  ].filter(Boolean);

  return {
    ...process.env,
    ANDROID_SDK_ROOT: sdkRoot,
    ANDROID_HOME: sdkRoot,
    JAVA_HOME: process.env.JAVA_HOME || "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
    PATH: pathEntries.join(":"),
  };
}

export function run(command, args, options = {}) {
  const result = commandResult(command, args, {
    env: buildAndroidEnv(),
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

export function commandExists(command) {
  const result = commandResult("bash", ["-lc", `command -v ${command}`], {
    env: buildAndroidEnv(),
  });
  return result.status === 0;
}

export function resolveAdbPath() {
  if (commandExists("adb")) {
    const result = commandResult("bash", ["-lc", "command -v adb"], {
      env: buildAndroidEnv(),
    });
    return String(result.stdout || "").trim();
  }

  const sdkRoot = resolveAndroidSdkRoot();
  const candidate = path.join(sdkRoot, "platform-tools", "adb");
  if (fs.existsSync(candidate)) {
    return candidate;
  }

  fail("adb is not installed. Install Android platform-tools first.");
}

export function resolveEmulatorPath() {
  if (commandExists("emulator")) {
    const result = commandResult("bash", ["-lc", "command -v emulator"], {
      env: buildAndroidEnv(),
    });
    return String(result.stdout || "").trim();
  }

  const sdkRoot = resolveAndroidSdkRoot();
  const candidate = path.join(sdkRoot, "emulator", "emulator");
  if (fs.existsSync(candidate)) {
    return candidate;
  }

  fail("Android emulator binary is not installed. Install the emulator package first.");
}

export function adbArgs(serial) {
  return serial ? ["-s", serial] : [];
}

export function parseConfig(configPath = DEFAULT_CONFIG_PATH) {
  const resolvedPath = path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  const raw = fs.readFileSync(resolvedPath, "utf8");
  return JSON.parse(raw);
}

export function listAndroidDevices(adbPath = resolveAdbPath()) {
  const result = run(adbPath, ["devices", "-l"]);
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("List of devices attached"))
    .map(line => {
      const [serial = "", state = "", ...rest] = line.split(/\s+/);
      const details = {};
      for (const part of rest) {
        const separatorIndex = part.indexOf(":");
        if (separatorIndex <= 0) {
          continue;
        }
        details[part.slice(0, separatorIndex)] = part.slice(separatorIndex + 1);
      }
      return {
        serial,
        state,
        details,
        raw: line,
      };
    })
    .filter(device => device.serial && device.state !== "offline");
}

export function resolveAndroidDeviceSelection(
  devices,
  { serial = null, preferEmulator = false, allowMissing = false } = {}
) {
  const onlineDevices = Array.isArray(devices) ? devices.filter(device => device.state === "device") : [];
  if (serial) {
    const matched = onlineDevices.find(device => device.serial === serial);
    if (!matched) {
      if (allowMissing) {
        return null;
      }
      fail(`No connected Android device matched serial "${serial}".`);
    }
    return matched;
  }

  if (onlineDevices.length === 0) {
    if (allowMissing) {
      return null;
    }
    fail("No Android device or emulator is connected.");
  }

  if (onlineDevices.length === 1) {
    return onlineDevices[0];
  }

  if (preferEmulator) {
    const emulator = onlineDevices.find(device => device.serial.startsWith("emulator-"));
    if (emulator) {
      return emulator;
    }
  }

  fail("Multiple Android devices are connected. Re-run with --serial.");
}

export function selectAndroidDevice({ adbPath = resolveAdbPath(), serial = null, preferEmulator = false } = {}) {
  return resolveAndroidDeviceSelection(listAndroidDevices(adbPath), {
    serial,
    preferEmulator,
  });
}

export function findAndroidDevice({ adbPath = resolveAdbPath(), serial = null, preferEmulator = false } = {}) {
  return resolveAndroidDeviceSelection(listAndroidDevices(adbPath), {
    serial,
    preferEmulator,
    allowMissing: true,
  });
}

export function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

export async function waitForDeviceBoot({ adbPath = resolveAdbPath(), serial, timeoutMs = 180000 }) {
  const startedAt = Date.now();
  run(adbPath, adbArgs(serial).concat(["wait-for-device"]));
  while (Date.now() - startedAt < timeoutMs) {
    const result = run(adbPath, adbArgs(serial).concat(["shell", "getprop", "sys.boot_completed"]));
    if (String(result.stdout || "").trim() === "1") {
      return;
    }
    await sleep(2000);
  }

  fail(`Timed out waiting for Android device ${serial || "(auto)"} to finish booting.`);
}

export async function waitForAndroidDeviceSelection({
  adbPath = resolveAdbPath(),
  serial = null,
  preferEmulator = false,
  timeoutMs = 180000,
} = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const matched = findAndroidDevice({
      adbPath,
      serial,
      preferEmulator,
    });
    if (matched) {
      return matched;
    }
    await sleep(1000);
  }

  fail(`Timed out waiting for Android device ${serial || "(auto)"} to appear.`);
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

export function runAdbShell(adbPath, serial, script) {
  return run(adbPath, adbArgs(serial).concat(["shell", script]));
}

export function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: buildAndroidEnv(),
    ...options,
  });
  child.unref();
  return child;
}

export function inferVaultNameFromConfig(config = null) {
  if (!config || typeof config.vaultName !== "string") {
    return null;
  }

  return config.vaultName.trim() || null;
}

export function inferVaultPathFromConfig(config = null) {
  if (!config || typeof config.vaultPath !== "string") {
    return null;
  }

  return config.vaultPath.trim() || null;
}

export function inferPluginIdFromConfig(config = null) {
  if (!config || typeof config.pluginId !== "string") {
    return DEFAULT_PLUGIN_ID;
  }

  return config.pluginId.trim() || DEFAULT_PLUGIN_ID;
}

export function inferPackageIdFromConfig(config = null) {
  if (!config || typeof config.packageId !== "string") {
    return DEFAULT_PACKAGE_ID;
  }

  return config.packageId.trim() || DEFAULT_PACKAGE_ID;
}
