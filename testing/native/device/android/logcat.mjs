#!/usr/bin/env node
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import {
  DEFAULT_PACKAGE_ID,
  buildAndroidEnv,
  resolveAdbPath,
  run,
  selectAndroidDevice,
} from "./utils.mjs";

function usage() {
  console.log(`Usage: node testing/native/device/android/logcat.mjs [options]

Tail Android logs for a connected emulator or device.

Options:
  --serial <id>           adb serial to target. Auto-selects if only one device is present.
  --package <id>          Filter to the running package pid. Default: md.obsidian
  --clear                 Clear logcat before tailing.
  --full                  Skip pid filtering and stream the full logcat.
  --help, -h              Show this help.`);
}

function fail(message) {
  console.error(`[android-logcat] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    serial: null,
    packageId: DEFAULT_PACKAGE_ID,
    clear: false,
    full: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--serial") {
      options.serial = String(argv[index + 1] || "").trim() || null;
      index += 1;
      continue;
    }
    if (arg === "--package") {
      options.packageId = String(argv[index + 1] || "").trim() || DEFAULT_PACKAGE_ID;
      index += 1;
      continue;
    }
    if (arg === "--clear") {
      options.clear = true;
      continue;
    }
    if (arg === "--full") {
      options.full = true;
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

const options = parseArgs(process.argv.slice(2));
const adbPath = resolveAdbPath();
const device = selectAndroidDevice({ adbPath, serial: options.serial, preferEmulator: true });

if (options.clear) {
  run(adbPath, ["-s", device.serial, "logcat", "-c"]);
}

const logcatArgs = ["-s", device.serial, "logcat"];
if (!options.full) {
  const pidResult = spawnSync(
    adbPath,
    ["-s", device.serial, "shell", "pidof", "-s", options.packageId],
    {
      encoding: "utf8",
      env: buildAndroidEnv(),
    },
  );
  const pid = String(pidResult.stdout || "").trim();
  if (!pid) {
    fail(`Package ${options.packageId} is not running. Launch Obsidian first or rerun with --full.`);
  }
  logcatArgs.push(`--pid=${pid}`);
}

const child = spawn(adbPath, logcatArgs, {
  stdio: "inherit",
  env: buildAndroidEnv(),
});

child.on("exit", code => {
  process.exit(code ?? 0);
});
