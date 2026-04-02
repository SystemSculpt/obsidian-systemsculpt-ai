import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildLatestWindowsBridgeRecordScript,
  buildWindowsBootstrapArgs,
  ensureFreshRemoteWindowsPluginVersion,
  resolveWindowsBootstrapHostedAuthSeed,
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
    hostedAuthSeed: {
      licenseKey: "license-from-sync",
      serverUrl: "https://api.systemsculpt.com",
    },
  });

  assert.deepEqual(args, [
    "--vault-name",
    "SystemSculptWindowsQA",
    "--vault-path",
    WINDOWS_QA_VAULT_PATH,
    "--timeout-ms",
    "123456",
    "--license-key",
    "license-from-sync",
    "--server-url",
    "https://api.systemsculpt.com",
    "--launch",
  ]);
});

test("resolveWindowsBootstrapHostedAuthSeed falls back to the best local plugin target", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "windows-hosted-auth-seed-"));
  const repoRoot = path.join(tempDir, "repo");
  const firstPluginDir = path.join(tempDir, "first-vault", ".obsidian", "plugins", "systemsculpt-ai");
  const secondPluginDir = path.join(tempDir, "second-vault", ".obsidian", "plugins", "systemsculpt-ai");
  await Promise.all([
    fs.mkdir(repoRoot, { recursive: true }),
    fs.mkdir(firstPluginDir, { recursive: true }),
    fs.mkdir(secondPluginDir, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(
      path.join(repoRoot, "systemsculpt-sync.config.json"),
      JSON.stringify({
        pluginTargets: [{ path: firstPluginDir }, { path: secondPluginDir }],
      }),
      "utf8"
    ),
    fs.writeFile(
      path.join(firstPluginDir, "data.json"),
      JSON.stringify({
        licenseKey: "first-license",
        licenseValid: true,
        enableSystemSculptProvider: true,
        serverUrl: "https://api.systemsculpt.com",
        selectedModelId: "local-pi-openrouter@@openai/gpt-5.4-mini",
      }),
      "utf8"
    ),
    fs.writeFile(
      path.join(secondPluginDir, "data.json"),
      JSON.stringify({
        licenseKey: "second-license",
        licenseValid: true,
        enableSystemSculptProvider: true,
        serverUrl: "https://api.systemsculpt.com",
        selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
      }),
      "utf8"
    ),
  ]);
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const seed = await resolveWindowsBootstrapHostedAuthSeed({ artifactRoot: repoRoot });

  assert.deepEqual(seed, {
    licenseKey: "second-license",
    serverUrl: "https://api.systemsculpt.com",
  });
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
      readRemoteWindowsPluginHostedAuthStateImpl: async () => ({
        licenseKeyLength: 36,
        enableSystemSculptProvider: true,
      }),
      readExpectedLocalPluginVersionImpl: async () => "5.3.2",
      runWindowsNodeModuleRemotelyImpl: async () => {
        remoteRuns += 1;
        return "{}";
      },
      resolveWindowsBootstrapHostedAuthSeedImpl: async () => ({
        licenseKey: "seeded-license",
        serverUrl: "https://api.systemsculpt.com",
      }),
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

test("ensureFreshRemoteWindowsPluginVersion relaunches when hosted auth is missing on an otherwise current build", async () => {
  const bridgeReads = [
    {
      pluginVersion: "5.3.2",
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
      readRemoteWindowsPluginHostedAuthStateImpl: async () => ({
        licenseKeyLength: 0,
        enableSystemSculptProvider: false,
      }),
      readExpectedLocalPluginVersionImpl: async () => "5.3.2",
      resolveWindowsBootstrapHostedAuthSeedImpl: async () => ({
        licenseKey: "seeded-license",
        serverUrl: "https://api.systemsculpt.com",
      }),
      runWindowsNodeModuleRemotelyImpl: async (_entryPath, options) => {
        remoteRuns += 1;
        assert.ok(options.args.includes("--license-key"));
        assert.ok(options.args.includes("seeded-license"));
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
  assert.equal(result.before.pluginVersion, "5.3.2");
  assert.equal(result.after.pluginVersion, "5.3.2");
});
