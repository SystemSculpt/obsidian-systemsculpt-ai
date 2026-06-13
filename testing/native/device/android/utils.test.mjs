import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAndroidSharedStorageReadyScript,
  inferAvdNameFromConfig,
  resolveAndroidDeviceSelection,
  waitForAndroidSharedStorage,
} from "./utils.mjs";

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

test("inferAvdNameFromConfig returns a trimmed configured AVD name", () => {
  assert.equal(
    inferAvdNameFromConfig({ avdName: " SystemSculpt_Pixel_9_API_36_1 " }),
    "SystemSculpt_Pixel_9_API_36_1"
  );
  assert.equal(inferAvdNameFromConfig({}), null);
});

test("buildAndroidSharedStorageReadyScript checks both sdcard aliases", () => {
  const script = buildAndroidSharedStorageReadyScript();

  assert.match(script, /\/sdcard\/Android/);
  assert.match(script, /\/storage\/self\/primary\/Android/);
});

test("waitForAndroidSharedStorage retries until shared storage is ready", async () => {
  let attempts = 0;
  const sleepDurations = [];

  await waitForAndroidSharedStorage({
    adbPath: "/mock/adb",
    serial: "emulator-5554",
    timeoutMs: 3000,
    pollMs: 1000,
    runAdbShellImpl(adbPath, serial, script) {
      attempts += 1;
      assert.equal(adbPath, "/mock/adb");
      assert.equal(serial, "emulator-5554");
      assert.equal(script, buildAndroidSharedStorageReadyScript());
      if (attempts < 3) {
        throw new Error("shared storage not mounted yet");
      }
    },
    sleepImpl: async (duration) => {
      sleepDurations.push(duration);
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(sleepDurations, [1000, 1000]);
});
