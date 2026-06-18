import test from "node:test";
import assert from "node:assert/strict";

import {
  findReachablePhysicalIosDevice,
  isReachablePhysicalIosDevice,
  selectReachablePhysicalIosDevice,
} from "./ios-device-selection.mjs";

function iosDevice(overrides = {}) {
  return {
    identifier: "device-id",
    deviceProperties: { name: "Release iPad" },
    hardwareProperties: {
      platform: "iOS",
      reality: "physical",
      udid: "00000000-0000000000000000",
    },
    connectionProperties: {
      pairingState: "paired",
      transportType: "wired",
    },
    ...overrides,
  };
}

test("isReachablePhysicalIosDevice accepts a wired paired physical iOS device", () => {
  assert.equal(isReachablePhysicalIosDevice(iosDevice()), true);
});

test("isReachablePhysicalIosDevice accepts localNetwork transport for wireless CoreDevice", () => {
  assert.equal(
    isReachablePhysicalIosDevice(
      iosDevice({
        connectionProperties: {
          pairingState: "paired",
          transportType: "localNetwork",
        },
      }),
    ),
    true,
  );
});

test("isReachablePhysicalIosDevice rejects remembered paired devices without an active transport", () => {
  assert.equal(
    isReachablePhysicalIosDevice(
      iosDevice({
        connectionProperties: {
          pairingState: "paired",
          tunnelState: "unavailable",
        },
      }),
    ),
    false,
  );
});

test("findReachablePhysicalIosDevice prefers wired devices", () => {
  const selected = findReachablePhysicalIosDevice({
    result: {
      devices: [
        iosDevice({
          identifier: "wireless",
          deviceProperties: { name: "Wireless iPad" },
          connectionProperties: { pairingState: "paired", transportType: "localNetwork" },
        }),
        iosDevice({
          identifier: "wired",
          deviceProperties: { name: "Wired iPad" },
          connectionProperties: { pairingState: "paired", transportType: "wired" },
        }),
      ],
    },
  });

  assert.equal(selected?.identifier, "wired");
});

test("selectReachablePhysicalIosDevice reports a requested stale paired device as not actively reachable", () => {
  assert.throws(
    () => selectReachablePhysicalIosDevice([
      iosDevice({
        deviceProperties: { name: "Michael’s iPad" },
        connectionProperties: { pairingState: "paired", tunnelState: "unavailable" },
      }),
    ], { requestedDevice: "Michael’s iPad" }),
    /paired, but is not actively reachable through CoreDevice/,
  );
});

test("selectReachablePhysicalIosDevice lets callers name the recovery command", () => {
  assert.throws(
    () => selectReachablePhysicalIosDevice([
      iosDevice({
        deviceProperties: { name: "Release iPad" },
        connectionProperties: { pairingState: "paired", tunnelState: "unavailable" },
      }),
    ], { recoveryAction: "re-run the canary preflight" }),
    /then re-run the canary preflight\./,
  );
});

test("selectReachablePhysicalIosDevice reports stale paired devices before sync or relaunch work", () => {
  assert.throws(
    () => selectReachablePhysicalIosDevice([
      iosDevice({
        deviceProperties: { name: "Remembered iPad" },
        connectionProperties: { pairingState: "paired", tunnelState: "unavailable" },
      }),
    ]),
    /Remembered iPad is paired, but is not actively reachable through CoreDevice.*re-run the iOS command/s,
  );
});
