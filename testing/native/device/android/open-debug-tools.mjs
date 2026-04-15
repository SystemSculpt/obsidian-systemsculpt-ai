#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_PACKAGE_ID,
  buildAndroidEnv,
  findAndroidDevice,
  inferAvdNameFromConfig,
  inferPackageIdFromConfig,
  inferVaultNameFromConfig,
  listAndroidDevices,
  parseConfig,
  resolveAdbPath,
  resolveEmulatorPath,
  run,
  runAdbShell,
  selectAndroidDevice,
  shellQuote,
  spawnDetached,
  waitForAndroidDeviceSelection,
  waitForDeviceBoot,
} from "./utils.mjs";

function usage() {
  console.log(`Usage: node testing/native/device/android/open-debug-tools.mjs [options]

Verified helper for the Android emulator/device debugging lane. It can boot a
named emulator, sync the latest plugin into the configured vault, relaunch
Obsidian, and open the host-side tools used for diagnosis.

Options:
  --config, -c <path>     Sync config to inspect. Default: ./systemsculpt-sync.android.json
  --serial <id>           adb serial to target.
  --avd <name>            Launch this emulator AVD if no device is connected.
  --package-id <id>       Android package id. Default: md.obsidian
  --vault <name>          Vault name for obsidian://open. Inferred from config when possible.
  --sync                  Run android:sync before relaunching.
  --reset-vault           Recreate the configured vault during sync.
  --skip-build            When used with --sync, skip npm run build and reuse the current artifact set.
  --headless              Launch the emulator without a window and skip opening host apps.
  --skip-relaunch         Skip the adb relaunch step.
  --skip-open-apps        Skip opening Android Studio and Chrome inspect.
  --open-studio           Force-open Android Studio even when Android Studio is already running.
  --boot-timeout-ms <n>   Device boot timeout in milliseconds. Default: 180000
  --help, -h              Show this help.`);
}

function fail(message) {
  console.error(`[android-debug] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    serial: null,
    avdName: null,
    packageId: DEFAULT_PACKAGE_ID,
    vaultName: null,
    sync: false,
    resetVault: false,
    build: true,
    headless: false,
    relaunch: true,
    openApps: true,
    openStudio: false,
    bootTimeoutMs: 180000,
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
    if (arg === "--avd") {
      options.avdName = String(argv[index + 1] || "").trim() || null;
      index += 1;
      continue;
    }
    if (arg === "--package-id") {
      options.packageId = String(argv[index + 1] || "").trim() || DEFAULT_PACKAGE_ID;
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
    if (arg === "--reset-vault") {
      options.resetVault = true;
      continue;
    }
    if (arg === "--skip-build") {
      options.build = false;
      continue;
    }
    if (arg === "--headless") {
      options.headless = true;
      options.openApps = false;
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
    if (arg === "--open-studio") {
      options.openStudio = true;
      continue;
    }
    if (arg === "--boot-timeout-ms") {
      options.bootTimeoutMs = Number.parseInt(String(argv[index + 1] || ""), 10) || options.bootTimeoutMs;
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

function commandExists(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
    env: buildAndroidEnv(),
  });
  return result.status === 0;
}

function maybeOpenApp(appPathOrName) {
  const result = spawnSync("open", ["-Ra", appPathOrName], { encoding: "utf8" });
  if (result.status === 0) {
    spawnSync("open", ["-a", appPathOrName], { encoding: "utf8" });
  }
}

function maybeOpenChromeInspect() {
  if (commandExists("open")) {
    spawnSync("open", ["-a", "Google Chrome", "chrome://inspect/#devices"], {
      encoding: "utf8",
    });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = parseConfig(options.configPath);
  const packageId = options.packageId || inferPackageIdFromConfig(config) || DEFAULT_PACKAGE_ID;
  const vaultName = options.vaultName || inferVaultNameFromConfig(config);
  const avdName =
    options.avdName ||
    inferAvdNameFromConfig(config) ||
    String(process.env.SYSTEMSCULPT_ANDROID_AVD || "").trim() ||
    null;
  const adbPath = resolveAdbPath();
  const selectedSerial = options.serial || config?.adbSerial || null;

  let device = null;
  const initialDevices = listAndroidDevices(adbPath).filter(entry => entry.state === "device");
  if (initialDevices.length > 0 || selectedSerial) {
    device = findAndroidDevice({ adbPath, serial: selectedSerial, preferEmulator: true });
  }

  if (!device && avdName) {
    const emulatorPath = resolveEmulatorPath();
    console.log(`[android-debug] Launching AVD ${avdName}`);
    const emulatorArgs = ["-avd", avdName];
    if (options.headless) {
      emulatorArgs.push("-no-window", "-no-boot-anim", "-gpu", "swiftshader_indirect", "-netfast");
    }
    spawnDetached(emulatorPath, emulatorArgs);
    if (selectedSerial) {
      device = await waitForAndroidDeviceSelection({
        adbPath,
        serial: selectedSerial,
        preferEmulator: true,
        timeoutMs: options.bootTimeoutMs,
      });
      await waitForDeviceBoot({
        adbPath,
        serial: device.serial,
        timeoutMs: options.bootTimeoutMs,
      });
    } else {
      await waitForDeviceBoot({
        adbPath,
        timeoutMs: options.bootTimeoutMs,
      });
      device = findAndroidDevice({ adbPath, preferEmulator: true });
    }
  }

  if (!device && selectedSerial) {
    fail(`No connected Android device matched serial "${selectedSerial}".`);
  }

  if (!device) {
    device = selectAndroidDevice({ adbPath, preferEmulator: true });
  }

  if (!device) {
    fail("No Android device is available.");
  }

  console.log(`[android-debug] Target device: ${device.serial}`);

  if (options.sync) {
    console.log(`[android-debug] Syncing plugin via ${options.configPath}`);
    const syncResult = spawnSync(
      "node",
      [
        "testing/native/device/android/sync-plugin.mjs",
        "--config",
        options.configPath,
        "--serial",
        device.serial,
        "--package-id",
        packageId,
        ...(options.resetVault ? ["--reset-vault"] : []),
        ...(options.build ? [] : ["--skip-build"]),
      ],
      {
        cwd: process.cwd(),
        stdio: "inherit",
        env: buildAndroidEnv(),
      },
    );
    if (syncResult.status !== 0) {
      fail("Android plugin sync failed.");
    }
  }

  if (options.relaunch) {
    console.log(`[android-debug] Relaunching ${packageId}`);
    runAdbShell(adbPath, device.serial, `am force-stop ${shellQuote(packageId)}`);
    if (vaultName) {
      const payloadUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}`;
      runAdbShell(
        adbPath,
        device.serial,
        `am start -W -a android.intent.action.VIEW -d ${shellQuote(payloadUrl)} ${shellQuote(packageId)}`,
      );
    } else {
      runAdbShell(
        adbPath,
        device.serial,
        `monkey -p ${shellQuote(packageId)} -c android.intent.category.LAUNCHER 1`,
      );
    }
  }

  if (options.openApps) {
    if (options.openStudio) {
      maybeOpenApp(path.join(process.env.HOME || "", "Applications", "Android Studio.app"));
    } else {
      maybeOpenApp(path.join(process.env.HOME || "", "Applications", "Android Studio.app"));
      maybeOpenApp("Android Studio");
    }
    maybeOpenChromeInspect();
  }

  console.log("[android-debug] Android debug tools are ready.");
}

main().catch(error => {
  fail(error.message || String(error));
});
