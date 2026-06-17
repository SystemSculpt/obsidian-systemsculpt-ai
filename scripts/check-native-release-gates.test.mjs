import test from "node:test";
import assert from "node:assert/strict";

import {
  IOS_CANARY_RELEASE_GATE,
  IOS_RELEASE_GATES,
  NATIVE_RELEASE_GATE_PHASES,
  OPTIONAL_IOS_RELEASE_GATE,
  REQUIRED_NATIVE_RELEASE_GATES,
  buildNativeReleaseGatePlan,
  formatGateCommand,
  parseArgs,
  probeIosAvailability,
  selectPairedPhysicalIosDevice,
} from "./check-native-release-gates.mjs";

test("selectPairedPhysicalIosDevice prefers a wired paired physical device", () => {
  const device = selectPairedPhysicalIosDevice({
    result: {
      devices: [
        {
          identifier: "wireless",
          hardwareProperties: { platform: "iOS", reality: "physical" },
          connectionProperties: { pairingState: "paired", transportType: "wireless" },
          deviceProperties: { name: "Wireless Phone" },
        },
        {
          identifier: "wired",
          hardwareProperties: { platform: "iOS", reality: "physical" },
          connectionProperties: { pairingState: "paired", transportType: "wired" },
          deviceProperties: { name: "Wired Phone" },
        },
      ],
    },
  });

  assert.equal(device?.identifier, "wired");
});

test("selectPairedPhysicalIosDevice ignores paired devices that are not currently connected", () => {
  const device = selectPairedPhysicalIosDevice({
    result: {
      devices: [
        {
          identifier: "remembered-ipad",
          hardwareProperties: { platform: "iPadOS", reality: "physical" },
          connectionProperties: { pairingState: "paired", transportType: "unknown" },
          deviceProperties: { name: "Remembered iPad" },
        },
      ],
    },
  });

  assert.equal(device, null);
});

test("selectPairedPhysicalIosDevice accepts tunneled paired devices when transport metadata is absent", () => {
  const device = selectPairedPhysicalIosDevice({
    result: {
      devices: [
        {
          identifier: "network-ipad",
          hardwareProperties: { platform: "iPadOS", reality: "physical" },
          connectionProperties: { pairingState: "paired", tunnelState: "connected" },
          deviceProperties: { name: "Network iPad" },
        },
      ],
    },
  });

  assert.equal(device?.identifier, "network-ipad");
});

test("selectPairedPhysicalIosDevice accepts CoreDevice localNetwork transport", () => {
  const device = selectPairedPhysicalIosDevice({
    result: {
      devices: [
        {
          identifier: "wireless-ipad",
          hardwareProperties: { platform: "iPadOS", reality: "physical" },
          connectionProperties: { pairingState: "paired", transportType: "localNetwork" },
          deviceProperties: { name: "Wireless iPad" },
        },
      ],
    },
  });

  assert.equal(device?.identifier, "wireless-ipad");
});

test("probeIosAvailability reports unavailable when xcrun is missing", () => {
  const result = probeIosAvailability({
    commandExistsImpl(command) {
      return command !== "xcrun";
    },
  });

  assert.deepEqual(result, {
    available: false,
    reason: "xcrun is unavailable on this host",
  });
});

test("parseArgs treats an iOS canary override as canary validation intent", () => {
  assert.deepEqual(
    parseArgs(["--allow-missing-ios-canary", "runner not provisioned yet"]),
    {
      requireIos: false,
      requireIosCanary: true,
      allowMissingIosCanaryReason: "runner not provisioned yet",
      githubRepo: "",
      githubRef: "",
      githubWaitTimeoutMs: 0,
      githubPollIntervalMs: 0,
      gatePhase: NATIVE_RELEASE_GATE_PHASES.ALL,
    },
  );
});

test("parseArgs exposes mutually exclusive local and hosted gate phases", () => {
  assert.equal(parseArgs(["--only-local"]).gatePhase, NATIVE_RELEASE_GATE_PHASES.LOCAL);
  assert.equal(parseArgs(["--only-hosted"]).gatePhase, NATIVE_RELEASE_GATE_PHASES.HOSTED);
  assert.throws(
    () => parseArgs(["--only-local", "--only-hosted"]),
    /Use only one of --only-local or --only-hosted/,
  );
});

test("probeIosAvailability reports an available paired device", () => {
  const result = probeIosAvailability({
    commandExistsImpl() {
      return true;
    },
    readDevicesImpl() {
      return {
        result: {
          devices: [
            {
              identifier: "ipad-1",
              hardwareProperties: { platform: "iPadOS", reality: "physical" },
              connectionProperties: { pairingState: "paired", transportType: "wired" },
              deviceProperties: { name: "Release iPad" },
            },
          ],
        },
      };
    },
  });

  assert.deepEqual(result, {
    available: true,
    reason: "Release iPad",
  });
});

test("probeIosAvailability reports unavailable when only remembered paired devices exist", () => {
  const result = probeIosAvailability({
    commandExistsImpl() {
      return true;
    },
    readDevicesImpl() {
      return {
        result: {
          devices: [
            {
              identifier: "remembered-ipad",
              hardwareProperties: { platform: "iPadOS", reality: "physical" },
              connectionProperties: { pairingState: "paired", transportType: "unknown" },
              deviceProperties: { name: "Remembered iPad" },
            },
          ],
        },
      };
    },
  });

  assert.equal(result.available, false);
  assert.match(result.reason, /Remembered iPad is paired, but is not actively reachable through CoreDevice/);
  assert.match(result.reason, /re-run the native release check/);
});

test("buildNativeReleaseGatePlan skips iOS when unavailable", () => {
  const plan = buildNativeReleaseGatePlan({
    iosAvailability: { available: false, reason: "no paired device" },
  });

  assert.equal(plan.length, REQUIRED_NATIVE_RELEASE_GATES.length + 1 + IOS_RELEASE_GATES.length);
  const windowsGate = plan.find((gate) => gate.id === "windows-e2e");
  assert.equal(windowsGate?.label, "Windows clean-install and desktop baselines GitHub check");
  assert.deepEqual(windowsGate?.args, ["scripts/check-github-required-checks.mjs", "--name", "windows-e2e"]);
  const canaryGate = plan.find((gate) => gate.id === IOS_CANARY_RELEASE_GATE.id);
  assert.equal(canaryGate?.required, true);
  assert.equal(canaryGate?.run, true);
  assert.deepEqual(canaryGate?.args, ["scripts/check-github-required-checks.mjs", "--name", "ios-canary-release"]);

  const iosGate = plan.find((gate) => gate.id === OPTIONAL_IOS_RELEASE_GATE.id);
  assert.equal(iosGate?.id, OPTIONAL_IOS_RELEASE_GATE.id);
  assert.equal(iosGate?.required, false);
  assert.equal(iosGate?.run, false);
  assert.equal(iosGate?.skipReason, "no paired device");
});

test("buildNativeReleaseGatePlan requires iOS when explicitly requested", () => {
  const plan = buildNativeReleaseGatePlan({
    requireIos: true,
    iosAvailability: { available: false, reason: "adapter missing" },
  });

  const iosGate = plan.find((gate) => gate.id === OPTIONAL_IOS_RELEASE_GATE.id);
  assert.equal(iosGate?.required, true);
  assert.equal(iosGate?.run, false);
  assert.equal(iosGate?.skipReason, "adapter missing");
});

test("buildNativeReleaseGatePlan runs the full local iOS sequence when a device is available", () => {
  const plan = buildNativeReleaseGatePlan({
    iosAvailability: { available: true, reason: "Release iPad" },
  });

  const iosGates = plan.filter((gate) => gate.id.startsWith("ios-") && gate.id !== "ios-canary");
  assert.deepEqual(iosGates.map((gate) => gate.id), ["ios-prepare", "ios-inspect", "ios-runtime"]);
  assert.deepEqual(
    iosGates.map((gate) => [gate.required, gate.run, gate.skipReason]),
    [
      [true, true, null],
      [true, true, null],
      [true, true, null],
    ],
  );
  assert.deepEqual(iosGates[0]?.args, [
    "run",
    "test:native:ios:debug:open",
    "--",
    "--sync",
    "--skip-open-apps",
  ]);
});

test("buildNativeReleaseGatePlan can require or explicitly override the iOS canary check", () => {
  const requiredPlan = buildNativeReleaseGatePlan({
    iosAvailability: { available: false, reason: "no paired device" },
    githubRef: "abc123",
    githubWaitTimeoutMs: 60000,
  });
  const requiredCanary = requiredPlan.find((gate) => gate.id === "ios-canary");
  assert.equal(requiredCanary?.required, true);
  assert.equal(requiredCanary?.run, true);
  assert.deepEqual(requiredCanary?.args, [
    "scripts/check-github-required-checks.mjs",
    "--name",
    "ios-canary-release",
    "--ref",
    "abc123",
    "--wait-timeout-ms",
    "60000",
  ]);

  const requiredWindows = requiredPlan.find((gate) => gate.id === "windows-e2e");
  assert.deepEqual(requiredWindows?.args, [
    "scripts/check-github-required-checks.mjs",
    "--name",
    "windows-e2e",
    "--ref",
    "abc123",
    "--wait-timeout-ms",
    "60000",
  ]);

  const overridePlan = buildNativeReleaseGatePlan({
    allowMissingIosCanaryReason: "runner not provisioned yet",
    iosAvailability: { available: false, reason: "no paired device" },
  });
  const overriddenCanary = overridePlan.find((gate) => gate.id === "ios-canary");
  assert.equal(overriddenCanary?.required, false);
  assert.equal(overriddenCanary?.run, false);
  assert.equal(overriddenCanary?.skipReason, "explicit override: runner not provisioned yet");
});

test("buildNativeReleaseGatePlan can split local and hosted release phases", () => {
  const localPlan = buildNativeReleaseGatePlan({
    gatePhase: NATIVE_RELEASE_GATE_PHASES.LOCAL,
    iosAvailability: { available: false, reason: "no paired device" },
  });
  assert.deepEqual(
    localPlan.map((gate) => gate.id),
    [
      "macos-desktop-baselines",
      "android-prepare",
      "android-runtime-extended",
      "ios-prepare",
      "ios-inspect",
      "ios-runtime",
    ],
  );
  assert.equal(localPlan.some((gate) => gate.id === "windows-e2e"), false);
  assert.equal(localPlan.some((gate) => gate.id === "ios-canary"), false);

  const hostedPlan = buildNativeReleaseGatePlan({
    gatePhase: NATIVE_RELEASE_GATE_PHASES.HOSTED,
    githubRef: "abc123",
    iosAvailability: { available: true, reason: "Release iPad" },
  });
  assert.deepEqual(
    hostedPlan.map((gate) => gate.id),
    ["windows-e2e", "ios-canary"],
  );
  assert.deepEqual(
    hostedPlan.map((gate) => gate.args),
    [
      ["scripts/check-github-required-checks.mjs", "--name", "windows-e2e", "--ref", "abc123"],
      ["scripts/check-github-required-checks.mjs", "--name", "ios-canary-release", "--ref", "abc123"],
    ],
  );
});

test("formatGateCommand renders npm scripts with passthrough args", () => {
  assert.equal(
    formatGateCommand({
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
    }),
    "npm run test:native:android:debug:open -- --config ./systemsculpt-sync.android.json --headless --sync --reset-vault",
  );
});
