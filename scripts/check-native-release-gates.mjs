#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const REQUIRED_NATIVE_RELEASE_GATES = Object.freeze([
  {
    id: "macos-desktop-baselines",
    label: "macOS desktop baselines",
    command: "npm",
    args: ["run", "test:native:desktop:baselines"],
  },
  {
    id: "windows-clean-install",
    label: "Windows clean-install parity",
    command: "npm",
    args: ["run", "test:native:windows:clean-install"],
  },
  {
    id: "windows-desktop-baselines",
    label: "Windows desktop baselines",
    command: "npm",
    args: ["run", "test:native:windows:baselines"],
  },
  {
    id: "android-prepare",
    label: "Android sync and headless relaunch",
    command: "npm",
    args: [
      "run",
      "test:native:android:debug:open",
      "--",
      "--config",
      "./systemsculpt-sync.android.json",
      "--headless",
      "--sync",
      "--reset-vault",
    ],
  },
  {
    id: "android-runtime-extended",
    label: "Android runtime smoke",
    command: "npm",
    args: ["run", "test:native:android:extended"],
  },
]);

export const OPTIONAL_IOS_RELEASE_GATE = Object.freeze({
  id: "ios-runtime",
  label: "iOS runtime smoke",
  command: "npm",
  args: ["run", "test:native:ios"],
});

function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv) {
  const options = {
    requireIos: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-ios") {
      options.requireIos = true;
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

function usage() {
  console.log(`Usage: node scripts/check-native-release-gates.mjs [options]

Run the mandatory native release matrix before shipping the Obsidian plugin.

Required lanes:
  - macOS desktop baselines
  - Windows clean-install parity
  - Windows desktop baselines
  - Android sync + runtime smoke

Optional lane:
  - iOS runtime smoke when a paired physical device is available

Options:
  --require-ios     Fail instead of skipping when the iOS lane is unavailable
  --help, -h        Show this help.`);
}

export function formatGateCommand(gate) {
  return `${gate.command} ${gate.args.join(" ")}`;
}

export function commandExists(command, spawnImpl = spawnSync) {
  const result = spawnImpl("bash", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0;
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
    `obsidian-systemsculpt-ai-${now()}-${random().toString(16).slice(2)}.json`,
  );

  try {
    const result = spawnImpl("xcrun", [...args, "--json-output", tempPath, "--quiet"], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30_000,
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      const stderr = String(result.stderr || "").trim();
      const stdout = String(result.stdout || "").trim();
      throw new Error(stderr || stdout || `xcrun ${args.join(" ")} failed with exit ${result.status}`);
    }

    return JSON.parse(fsImpl.readFileSync(tempPath, "utf8"));
  } finally {
    fsImpl.rmSync(tempPath, { force: true });
  }
}

export function selectPairedPhysicalIosDevice(payload) {
  const devices = Array.isArray(payload?.result?.devices)
    ? payload.result.devices
    : Array.isArray(payload?.devices)
      ? payload.devices
      : [];

  const candidates = devices.filter((device) => {
    const platform = String(device?.hardwareProperties?.platform || "").trim();
    const reality = String(device?.hardwareProperties?.reality || "").trim();
    const pairingState = String(device?.connectionProperties?.pairingState || "").trim();
    const transportType = String(device?.connectionProperties?.transportType || "").trim().toLowerCase();
    const tunnelState = String(device?.connectionProperties?.tunnelState || "").trim().toLowerCase();
    const connected =
      transportType === "wired" ||
      transportType === "wireless" ||
      transportType === "network" ||
      tunnelState === "available" ||
      tunnelState === "connected" ||
      tunnelState === "active";
    return (
      (platform === "iOS" || platform === "iPadOS") &&
      reality === "physical" &&
      pairingState === "paired" &&
      connected
    );
  });

  const wired = candidates.filter((device) => {
    return String(device?.connectionProperties?.transportType || "").trim() === "wired";
  });

  return wired[0] || candidates[0] || null;
}

export function probeIosAvailability(
  {
    commandExistsImpl = commandExists,
    readDevicesImpl = null,
  } = {},
) {
  if (!commandExistsImpl("xcrun")) {
    return {
      available: false,
      reason: "xcrun is unavailable on this host",
    };
  }

  if (!commandExistsImpl("remotedebug_ios_webkit_adapter")) {
    return {
      available: false,
      reason: "remotedebug_ios_webkit_adapter is unavailable on this host",
    };
  }

  try {
    const payload = readDevicesImpl
      ? readDevicesImpl()
      : readJsonFromDevicectl(["devicectl", "list", "devices"]);
    const device = selectPairedPhysicalIosDevice(payload);
    if (!device) {
      return {
        available: false,
        reason: "no connected physical iOS device is currently available",
      };
    }

    const label =
      String(device?.deviceProperties?.name || "").trim() ||
      String(device?.identifier || "").trim() ||
      "paired iOS device";

    return {
      available: true,
      reason: label,
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildNativeReleaseGatePlan({
  requireIos = false,
  iosAvailability = { available: false, reason: "not probed" },
} = {}) {
  const plan = REQUIRED_NATIVE_RELEASE_GATES.map((gate) => ({
    ...gate,
    required: true,
    run: true,
    skipReason: null,
  }));

  const iosRequired = Boolean(requireIos || iosAvailability.available);
  plan.push({
    ...OPTIONAL_IOS_RELEASE_GATE,
    required: iosRequired,
    run: Boolean(iosAvailability.available),
    skipReason: iosAvailability.available ? null : String(iosAvailability.reason || "unavailable"),
  });

  return plan;
}

function logStep(message) {
  console.log(`[release-native] ${message}`);
}

export function runGate(gate, { spawnImpl = spawnSync, cwd = process.cwd(), env = process.env } = {}) {
  const result = spawnImpl(gate.command, gate.args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    fail(`${formatGateCommand(gate)} failed with exit ${result.status ?? 1}`);
  }
}

export function runNativeReleaseGates(options = {}, dependencies = {}) {
  const iosAvailability = probeIosAvailability(dependencies);
  const plan = buildNativeReleaseGatePlan({
    requireIos: options.requireIos,
    iosAvailability,
  });

  logStep("Native release contract:");
  for (const gate of plan) {
    if (gate.run) {
      logStep(`- required: ${gate.label}`);
      continue;
    }
    const requirement = gate.required ? "required but unavailable" : "optional and unavailable";
    logStep(`- ${requirement}: ${gate.label} (${gate.skipReason})`);
  }

  const blockedRequiredGates = plan.filter((gate) => gate.required && !gate.run);
  if (blockedRequiredGates.length > 0) {
    fail(
      `Required native release gate is unavailable: ${blockedRequiredGates
        .map((gate) => `${gate.label} (${gate.skipReason})`)
        .join(", ")}`,
    );
  }

  for (const gate of plan) {
    if (!gate.run) {
      continue;
    }
    logStep(`Running ${gate.label}: ${formatGateCommand(gate)}`);
    runGate(gate, dependencies);
  }

  logStep("Native release gates passed.");
  return {
    iosAvailability,
    plan,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  runNativeReleaseGates(options);
}

const isDirectExecution = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isDirectExecution) {
  try {
    main();
  } catch (error) {
    console.error(
      `[release-native] ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
