import test from "node:test";
import assert from "node:assert/strict";

import {
  inspectSyncConfig,
  parseArgs,
  runIosCanaryPreflight,
} from "./canary-preflight.mjs";

function memoryFs(files = {}) {
  return {
    existsSync(filePath) {
      return Object.prototype.hasOwnProperty.call(files, filePath);
    },
    readFileSync(filePath) {
      if (!this.existsSync(filePath)) {
        throw new Error(`missing ${filePath}`);
      }
      return files[filePath];
    },
  };
}

function spawnForCommands(commands = {}) {
  return (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    const value = commands[key];
    if (!value) {
      return {
        status: 1,
        stderr: `unexpected command: ${key}`,
      };
    }
    return {
      status: 0,
      stdout: value,
      stderr: "",
    };
  };
}

function releaseIpad(overrides = {}) {
  return {
    identifier: "device-id",
    hardwareProperties: {
      platform: "iPadOS",
      reality: "physical",
      udid: "00000000-0000000000000000",
    },
    connectionProperties: {
      pairingState: "paired",
      transportType: "wired",
    },
    deviceProperties: {
      name: "Release iPad",
      osVersionNumber: "18.5",
      developerModeStatus: "enabled",
    },
    ...overrides,
  };
}

test("parseArgs supports canary preflight options", () => {
  const parsed = parseArgs([
    "--config",
    "systemsculpt-sync.ios.json",
    "--device",
    "Release iPad",
    "--skip-config",
    "--json",
  ]);

  assert.equal(parsed.configPath.endsWith("systemsculpt-sync.ios.json"), true);
  assert.equal(parsed.requestedDevice, "Release iPad");
  assert.equal(parsed.skipConfig, true);
  assert.equal(parsed.json, true);
});

test("parseArgs rejects missing or flag-like values for --config and --device", () => {
  assert.throws(() => parseArgs(["--config"]), /Missing value for --config/);
  assert.throws(() => parseArgs(["--config", "--json"]), /Missing value for --config/);
  assert.throws(() => parseArgs(["--device", "--skip-config"]), /Missing value for --device/);
});

test("inspectSyncConfig requires at least one plugin target", () => {
  assert.throws(
    () => inspectSyncConfig("/tmp/missing.json", { fsImpl: memoryFs({}) }),
    /iOS sync config is missing/,
  );

  assert.throws(
    () =>
      inspectSyncConfig("/tmp/empty.json", {
        fsImpl: memoryFs({
          "/tmp/empty.json": JSON.stringify({ pluginTargets: [] }),
        }),
      }),
    /at least one pluginTargets entry/,
  );

  assert.deepEqual(
    inspectSyncConfig("/tmp/ok.json", {
      fsImpl: memoryFs({
        "/tmp/ok.json": JSON.stringify({
          pluginTargets: [{ path: "/Users/example/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/.obsidian/plugins/systemsculpt-ai" }],
          mirrorTargets: [{ path: "/tmp/mirror" }],
        }),
      }),
    }),
    {
      path: "/tmp/ok.json",
      pluginTargets: 1,
      mirrorTargets: 1,
    },
  );
});

test("runIosCanaryPreflight reports a ready host and device", () => {
  const result = runIosCanaryPreflight(
    {
      configPath: "/tmp/ios.json",
      requestedDevice: "Release iPad",
    },
    {
      fsImpl: memoryFs({
        "/tmp/ios.json": JSON.stringify({ pluginTargets: [{ path: "/tmp/plugin" }] }),
      }),
      spawnImpl: spawnForCommands({
        "xcode-select -p": "/Applications/Xcode.app/Contents/Developer\n",
        "bash -lc command -v xcrun": "/usr/bin/xcrun\n",
        "bash -lc command -v remotedebug_ios_webkit_adapter": "/opt/homebrew/bin/remotedebug_ios_webkit_adapter\n",
      }),
      readDevicesImpl() {
        return {
          result: {
            devices: [releaseIpad()],
          },
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.config.pluginTargets, 1);
  assert.equal(result.tools.xcodePath, "/Applications/Xcode.app/Contents/Developer");
  assert.equal(result.device.label, "Release iPad");
  assert.equal(result.device.transportType, "wired");
});

test("runIosCanaryPreflight fails before launch work when the requested device is stale", () => {
  assert.throws(
    () =>
      runIosCanaryPreflight(
        {
          skipConfig: true,
          requestedDevice: "Release iPad",
        },
        {
          spawnImpl: spawnForCommands({
            "xcode-select -p": "/Applications/Xcode.app/Contents/Developer\n",
            "bash -lc command -v xcrun": "/usr/bin/xcrun\n",
            "bash -lc command -v remotedebug_ios_webkit_adapter": "/opt/homebrew/bin/remotedebug_ios_webkit_adapter\n",
          }),
          readDevicesImpl() {
            return {
              result: {
                devices: [
                  releaseIpad({
                    connectionProperties: {
                      pairingState: "paired",
                      tunnelState: "unavailable",
                    },
                  }),
                ],
              },
            };
          },
        },
      ),
    /paired, but is not actively reachable through CoreDevice.*re-run the iOS canary preflight/s,
  );
});
