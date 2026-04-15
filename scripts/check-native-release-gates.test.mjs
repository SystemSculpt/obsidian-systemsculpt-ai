import test from "node:test";
import assert from "node:assert/strict";

import {
  OPTIONAL_IOS_RELEASE_GATE,
  REQUIRED_NATIVE_RELEASE_GATES,
  buildNativeReleaseGatePlan,
  formatGateCommand,
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

  assert.deepEqual(result, {
    available: false,
    reason: "no connected physical iOS device is currently available",
  });
});

test("buildNativeReleaseGatePlan skips iOS when unavailable", () => {
  const plan = buildNativeReleaseGatePlan({
    iosAvailability: { available: false, reason: "no paired device" },
  });

  assert.equal(plan.length, REQUIRED_NATIVE_RELEASE_GATES.length + 1);
  const iosGate = plan.at(-1);
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

  const iosGate = plan.at(-1);
  assert.equal(iosGate?.required, true);
  assert.equal(iosGate?.run, false);
  assert.equal(iosGate?.skipReason, "adapter missing");
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
