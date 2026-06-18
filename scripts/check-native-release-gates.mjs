#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  findReachablePhysicalIosDevice,
  listDevicectlDevices,
  selectReachablePhysicalIosDevice,
} from "../testing/native/shared/ios-device-selection.mjs";

export const REQUIRED_NATIVE_RELEASE_GATES = Object.freeze([
  {
    id: "macos-desktop-baselines",
    label: "macOS desktop baselines",
    phase: "local",
    command: "npm",
    args: ["run", "test:native:desktop:baselines"],
  },
  {
    id: "windows-e2e",
    label: "Windows clean-install and desktop baselines GitHub check",
    phase: "hosted",
    command: "node",
    args: ["scripts/check-github-required-checks.mjs", "--name", "windows-e2e"],
  },
  {
    id: "android-prepare",
    label: "Android sync and headless relaunch",
    phase: "local",
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
    phase: "local",
    command: "npm",
    args: ["run", "test:native:android:extended"],
  },
]);

export const OPTIONAL_IOS_RELEASE_GATE = Object.freeze({
  id: "ios-runtime",
  label: "iOS runtime smoke",
  phase: "local",
  command: "npm",
  args: ["run", "test:native:ios"],
});

export const IOS_RELEASE_GATES = Object.freeze([
  {
    id: "ios-prepare",
    label: "iOS sync and relaunch",
    phase: "local",
    command: "npm",
    args: [
      "run",
      "test:native:ios:debug:open",
      "--",
      "--sync",
      "--skip-open-apps",
    ],
  },
  {
    id: "ios-inspect",
    label: "iOS plugin inspection",
    phase: "local",
    command: "npm",
    args: ["run", "test:native:ios:inspect:plugin", "--", "--strict"],
  },
  OPTIONAL_IOS_RELEASE_GATE,
]);

export const IOS_CANARY_RELEASE_GATE = Object.freeze({
  id: "ios-canary",
  label: "iOS canary release GitHub check",
  phase: "hosted",
  command: "node",
  args: ["scripts/check-github-required-checks.mjs", "--name", "ios-canary-release"],
});

export const NATIVE_RELEASE_GATE_PHASES = Object.freeze({
  ALL: "all",
  LOCAL: "local",
  HOSTED: "hosted",
});

function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv) {
  const options = {
    requireIos: false,
    requireIosCanary: true,
    allowMissingIosCanaryReason: "",
    githubRepo: "",
    githubRef: "",
    githubWaitTimeoutMs: 0,
    githubPollIntervalMs: 0,
    gatePhase: NATIVE_RELEASE_GATE_PHASES.ALL,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-ios") {
      options.requireIos = true;
      continue;
    }
    if (arg === "--require-ios-canary") {
      options.requireIosCanary = true;
      continue;
    }
    if (arg === "--only-local") {
      if (options.gatePhase === NATIVE_RELEASE_GATE_PHASES.HOSTED) {
        fail("Use only one of --only-local or --only-hosted");
      }
      options.gatePhase = NATIVE_RELEASE_GATE_PHASES.LOCAL;
      continue;
    }
    if (arg === "--only-hosted") {
      if (options.gatePhase === NATIVE_RELEASE_GATE_PHASES.LOCAL) {
        fail("Use only one of --only-local or --only-hosted");
      }
      options.gatePhase = NATIVE_RELEASE_GATE_PHASES.HOSTED;
      continue;
    }
    if (arg === "--allow-missing-ios-canary") {
      const reason = String(argv[index + 1] || "").trim();
      index += 1;
      if (!reason || reason.startsWith("-")) {
        fail("--allow-missing-ios-canary requires a short reason");
      }
      options.allowMissingIosCanaryReason = reason;
      options.requireIosCanary = true;
      continue;
    }
    if (arg === "--github-repo") {
      options.githubRepo = String(argv[index + 1] || "").trim();
      index += 1;
      if (!options.githubRepo) {
        fail("--github-repo requires owner/name");
      }
      continue;
    }
    if (arg === "--github-ref") {
      options.githubRef = String(argv[index + 1] || "").trim();
      index += 1;
      if (!options.githubRef) {
        fail("--github-ref requires a commit SHA or ref");
      }
      continue;
    }
    if (arg === "--github-wait-timeout-ms") {
      options.githubWaitTimeoutMs = Number(argv[index + 1]) || 0;
      index += 1;
      continue;
    }
    if (arg === "--github-poll-interval-ms") {
      options.githubPollIntervalMs = Number(argv[index + 1]) || 0;
      index += 1;
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
  - Windows clean-install parity and desktop baselines via GitHub check "windows-e2e"
  - Android sync + runtime smoke
  - GitHub iOS canary release check "ios-canary-release"

Optional lane:
  - local iOS sync + inspection + runtime smoke when a paired physical device is available

Options:
  --only-local                     Run only local gates: macOS, Android, and local real-device iOS when available
  --only-hosted                    Run only hosted GitHub gates: Windows E2E and iOS canary
  --require-ios                    Fail instead of skipping when the local iOS lane is unavailable
  --require-ios-canary             Require the GitHub check named "ios-canary-release" on this commit (default)
  --allow-missing-ios-canary <why> Skip the GitHub iOS canary requirement with an explicit reason
  --github-repo <owner/name>       Repository for GitHub check lookups
  --github-ref <sha-or-ref>        Commit SHA/ref for GitHub check lookups
  --github-wait-timeout-ms <n>     Poll GitHub checks until they pass or this timeout elapses
  --github-poll-interval-ms <n>    Poll interval for GitHub checks
  --help, -h                       Show this help.`);
}

function gateMatchesPhase(gate, gatePhase = NATIVE_RELEASE_GATE_PHASES.ALL) {
  return gatePhase === NATIVE_RELEASE_GATE_PHASES.ALL || gate.phase === gatePhase;
}

export function formatGateCommand(gate) {
  return `${gate.command} ${gate.args.join(" ")}`;
}

function withGithubCheckOptions(gate, options = {}) {
  if (!["windows-e2e", "ios-canary"].includes(gate.id)) {
    return gate;
  }

  const args = [...gate.args];
  if (options.githubRepo) {
    args.push("--repo", options.githubRepo);
  }
  if (options.githubRef) {
    args.push("--ref", options.githubRef);
  }
  if (options.githubWaitTimeoutMs) {
    args.push("--wait-timeout-ms", String(options.githubWaitTimeoutMs));
  }
  if (options.githubPollIntervalMs) {
    args.push("--poll-interval-ms", String(options.githubPollIntervalMs));
  }

  return {
    ...gate,
    args,
  };
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
  return findReachablePhysicalIosDevice(payload);
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
    const device = selectReachablePhysicalIosDevice(listDevicectlDevices(payload), {
      recoveryAction: "re-run the native release check",
    });

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
  requireIosCanary = true,
  allowMissingIosCanaryReason = "",
  githubRepo = "",
  githubRef = "",
  githubWaitTimeoutMs = 0,
  githubPollIntervalMs = 0,
  gatePhase = NATIVE_RELEASE_GATE_PHASES.ALL,
  iosAvailability = { available: false, reason: "not probed" },
} = {}) {
  const githubCheckOptions = {
    githubRepo,
    githubRef,
    githubWaitTimeoutMs,
    githubPollIntervalMs,
  };
  const plan = REQUIRED_NATIVE_RELEASE_GATES.map((gate) => ({
    ...withGithubCheckOptions(gate, githubCheckOptions),
    required: true,
    run: true,
    skipReason: null,
  }));

  const shouldRunIosCanary = Boolean(requireIosCanary && !allowMissingIosCanaryReason);
  plan.push({
    ...withGithubCheckOptions(IOS_CANARY_RELEASE_GATE, githubCheckOptions),
    required: shouldRunIosCanary,
    run: shouldRunIosCanary,
    skipReason: shouldRunIosCanary
      ? null
      : allowMissingIosCanaryReason
        ? `explicit override: ${allowMissingIosCanaryReason}`
        : "not required by this invocation",
  });

  const iosRequired = Boolean(requireIos || iosAvailability.available);
  plan.push(...IOS_RELEASE_GATES.map((gate) => ({
    ...gate,
    required: iosRequired,
    run: Boolean(iosAvailability.available),
    skipReason: iosAvailability.available ? null : String(iosAvailability.reason || "unavailable"),
  })));

  return plan.filter((gate) => gateMatchesPhase(gate, gatePhase));
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
  const gatePhase = options.gatePhase || NATIVE_RELEASE_GATE_PHASES.ALL;
  const iosAvailability = gatePhase === NATIVE_RELEASE_GATE_PHASES.HOSTED
    ? { available: false, reason: "hosted-only gate phase" }
    : probeIosAvailability(dependencies);
  const plan = buildNativeReleaseGatePlan({
    requireIos: options.requireIos,
    requireIosCanary: options.requireIosCanary,
    allowMissingIosCanaryReason: options.allowMissingIosCanaryReason,
    githubRepo: options.githubRepo,
    githubRef: options.githubRef,
    githubWaitTimeoutMs: options.githubWaitTimeoutMs,
    githubPollIntervalMs: options.githubPollIntervalMs,
    gatePhase,
    iosAvailability,
  });

  logStep(`Native release contract (${gatePhase} gates):`);
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
