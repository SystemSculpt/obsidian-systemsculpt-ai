import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLatestWindowsBridgeRecordScript,
  buildWindowsBootstrapArgs,
  ensureFreshRemoteWindowsPluginVersion,
} from "./runtime-version.mjs";

const WINDOWS_QA_VAULT_PATH = "C:/Vaults/SystemSculptWindowsQA";

test("buildLatestWindowsBridgeRecordScript can filter by vault and plugin id", () => {
  const script = buildLatestWindowsBridgeRecordScript({
    pluginId: "systemsculpt-ai",
    vaultName: "SystemSculptWindowsQA",
    vaultPath: WINDOWS_QA_VAULT_PATH,
  });

  assert.match(script, /pluginId = 'systemsculpt-ai'/);
  assert.match(script, /vaultName = 'SystemSculptWindowsQA'/);
  assert.match(script, /vaultPath = 'C:\/Vaults\/SystemSculptWindowsQA'/);
  assert.match(script, /ConvertTo-Json -Compress -Depth 5/);
});

test("buildWindowsBootstrapArgs forwards the selected vault and launch timeout", () => {
  const args = buildWindowsBootstrapArgs({
    vaultName: "SystemSculptWindowsQA",
    vaultPath: WINDOWS_QA_VAULT_PATH,
    launchTimeoutMs: 123456,
  });

  assert.deepEqual(args, [
    "--vault-name",
    "SystemSculptWindowsQA",
    "--vault-path",
    WINDOWS_QA_VAULT_PATH,
    "--timeout-ms",
    "123456",
    "--launch",
  ]);
});

test("ensureFreshRemoteWindowsPluginVersion skips the relaunch when the bridge is already current", async () => {
  let remoteRuns = 0;

  const result = await ensureFreshRemoteWindowsPluginVersion(
    {
      expectedPluginVersion: "5.3.2",
    },
    {
      readLatestRemoteWindowsBridgeRecordImpl: async () => ({
        pluginVersion: "5.3.2",
        startedAt: "2026-03-30T16:56:26.946Z",
        vaultName: "SystemSculptWindowsQA",
        vaultPath: WINDOWS_QA_VAULT_PATH,
      }),
      readExpectedLocalPluginVersionImpl: async () => "5.3.2",
      runWindowsNodeModuleRemotelyImpl: async () => {
        remoteRuns += 1;
        return "{}";
      },
    }
  );

  assert.equal(remoteRuns, 0);
  assert.equal(result.relaunched, false);
  assert.equal(result.after.pluginVersion, "5.3.2");
});

test("ensureFreshRemoteWindowsPluginVersion relaunches the Windows VM when the bridge version is stale", async () => {
  const bridgeReads = [
    {
      pluginVersion: "5.3.1",
      startedAt: "2026-03-30T16:46:26.085Z",
      vaultName: "SystemSculptWindowsQA",
      vaultPath: WINDOWS_QA_VAULT_PATH,
    },
    {
      pluginVersion: "5.3.2",
      startedAt: "2026-03-30T16:56:26.946Z",
      vaultName: "SystemSculptWindowsQA",
      vaultPath: WINDOWS_QA_VAULT_PATH,
    },
  ];
  let remoteRuns = 0;

  const result = await ensureFreshRemoteWindowsPluginVersion(
    {
      expectedPluginVersion: "5.3.2",
      timeoutMs: 5000,
      pollMs: 1,
    },
    {
      readLatestRemoteWindowsBridgeRecordImpl: async () => {
        return bridgeReads.shift() || {
          pluginVersion: "5.3.2",
          startedAt: "2026-03-30T16:56:26.946Z",
          vaultName: "SystemSculptWindowsQA",
          vaultPath: WINDOWS_QA_VAULT_PATH,
        };
      },
      readRemoteWindowsPluginManifestVersionImpl: async () => ({
        version: "5.3.2",
      }),
      readExpectedLocalPluginVersionImpl: async () => "5.3.2",
      runWindowsNodeModuleRemotelyImpl: async (_entryPath, options) => {
        remoteRuns += 1;
        assert.ok(options.args.includes("--launch"));
        return JSON.stringify({
          launch: {
            ok: true,
          },
        });
      },
      sleepImpl: async () => {},
    }
  );

  assert.equal(remoteRuns, 1);
  assert.equal(result.relaunched, true);
  assert.equal(result.before.pluginVersion, "5.3.1");
  assert.equal(result.after.pluginVersion, "5.3.2");
  assert.equal(result.remoteManifestVersion, "5.3.2");
});
