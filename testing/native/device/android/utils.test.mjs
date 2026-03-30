import test from "node:test";
import assert from "node:assert/strict";

import { resolveAndroidDeviceSelection } from "./utils.mjs";

test("resolveAndroidDeviceSelection returns null for a missing configured serial when allowMissing is enabled", () => {
  const selected = resolveAndroidDeviceSelection(
    [{ serial: "emulator-5556", state: "device" }],
    {
      serial: "emulator-5554",
      allowMissing: true,
    }
  );

  assert.equal(selected, null);
});

test("resolveAndroidDeviceSelection prefers an emulator when multiple devices are connected", () => {
  const selected = resolveAndroidDeviceSelection(
    [
      { serial: "R5CW123456", state: "device" },
      { serial: "emulator-5554", state: "device" },
    ],
    {
      preferEmulator: true,
    }
  );

  assert.deepEqual(selected, { serial: "emulator-5554", state: "device" });
});

test("resolveAndroidDeviceSelection ignores offline records when matching a serial", () => {
  const selected = resolveAndroidDeviceSelection(
    [
      { serial: "emulator-5554", state: "offline" },
      { serial: "emulator-5554", state: "device" },
    ],
    {
      serial: "emulator-5554",
    }
  );

  assert.deepEqual(selected, { serial: "emulator-5554", state: "device" });
});
