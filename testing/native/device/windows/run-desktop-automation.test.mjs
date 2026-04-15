import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildRemoteWindowsDesktopAutomationArgs,
  buildListWindowsBridgeRecordsScript,
  parseArgs,
  parseRemoteBridgeRecords,
  resolveRemoteWindowsDesktopAutomationProviderConfig,
  selectLatestRemoteBridgeRecord,
  WindowsLocalBridgeDiscovery,
} from "./run-desktop-automation.mjs";

test("parseArgs accepts the Windows transport selectors and no-local-Pi override", () => {
  const parsed = parseArgs([
    "--case",
    "chatview-stress",
    "--transport",
    "ssh",
    "--host",
    "custom-windows-host",
    "--allow-local-pi",
    "--provider-id",
    "openrouter",
    "--provider-api-key",
    "sk-openrouter",
    "--no-reload",
  ]);

  assert.equal(parsed.caseName, "chatview-stress");
  assert.equal(parsed.transport, "ssh");
  assert.equal(parsed.sshHost, "custom-windows-host");
  assert.equal(parsed.allowLocalPi, true);
  assert.equal(parsed.providerId, "openrouter");
  assert.equal(parsed.providerApiKey, "sk-openrouter");
  assert.equal(parsed.reload, false);
});

test("buildListWindowsBridgeRecordsScript enumerates the Windows discovery directory", () => {
  const script = buildListWindowsBridgeRecordsScript();

  assert.match(script, /\.systemsculpt\/obsidian-automation/);
  assert.match(script, /pluginId -eq 'systemsculpt-ai'/);
  assert.match(script, /ConvertTo-Json -Compress -Depth 5/);
});

test("buildRemoteWindowsDesktopAutomationArgs preserves guest-runner flags", () => {
  const args = buildRemoteWindowsDesktopAutomationArgs({
    caseName: "baselines",
    vaultName: "SystemSculptWindowsQA",
    vaultPath: "C:/Users/TestUser/Documents/SystemSculptWindowsQA",
    fixtureDir: "fixtures",
    webFetchUrl: "https://example.com/article",
    youtubeUrl: "https://youtube.com/watch?v=abc123",
    repeat: 3,
    pauseMs: 1500,
    reload: false,
    allowSingleModelFallback: true,
    allowLocalPi: true,
    providerId: "openrouter",
    providerApiKey: "sk-openrouter",
  });

  assert.deepEqual(args, [
    "--case",
    "baselines",
    "--vault-name",
    "SystemSculptWindowsQA",
    "--vault-path",
    "C:/Users/TestUser/Documents/SystemSculptWindowsQA",
    "--fixture-dir",
    "fixtures",
    "--web-fetch-url",
    "https://example.com/article",
    "--youtube-url",
    "https://youtube.com/watch?v=abc123",
    "--repeat",
    "3",
    "--pause-ms",
    "1500",
    "--no-reload",
    "--allow-single-model-fallback",
    "--allow-local-pi",
    "--provider-id",
    "openrouter",
    "--provider-api-key",
    "sk-openrouter",
  ]);
});

test("resolveRemoteWindowsDesktopAutomationProviderConfig defaults to OpenRouter when its key is available", () => {
  const config = resolveRemoteWindowsDesktopAutomationProviderConfig(
    {},
    {
      OPENROUTER_API_KEY: "sk-openrouter",
    }
  );

  assert.deepEqual(config, {
    providerId: "openrouter",
    providerApiKey: "sk-openrouter",
  });
});

test("parseRemoteBridgeRecords tolerates prompt noise around a JSON array payload", () => {
  const parsed = parseRemoteBridgeRecords(
    [
      "Windows PowerShell",
      '[{"pluginId":"systemsculpt-ai","vaultName":"A","startedAt":"2026-03-29T10:00:00.000Z","port":61399,"token":"abc"}]',
    ].join("\n")
  );

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].vaultName, "A");
  assert.equal(parsed[0].port, 61399);
});

test("selectLatestRemoteBridgeRecord honors vault filters and excludeStartedAt", () => {
  const records = [
    {
      pluginId: "systemsculpt-ai",
      vaultName: "TargetVault",
      vaultPath: "C:/Vaults/TargetVault",
      startedAt: "2026-03-29T10:05:00.000Z",
      port: 62002,
      token: "newer",
    },
    {
      pluginId: "systemsculpt-ai",
      vaultName: "TargetVault",
      vaultPath: "C:/Vaults/TargetVault",
      startedAt: "2026-03-29T10:00:00.000Z",
      port: 62001,
      token: "older",
    },
    {
      pluginId: "systemsculpt-ai",
      vaultName: "OtherVault",
      vaultPath: "C:/Vaults/OtherVault",
      startedAt: "2026-03-29T10:10:00.000Z",
      port: 62003,
      token: "other",
    },
  ];

  const selected = selectLatestRemoteBridgeRecord(records, {
    vaultName: "TargetVault",
    excludeStartedAt: "2026-03-29T10:05:00.000Z",
  });

  assert.equal(selected?.port, 62001);
  assert.equal(selected?.token, "older");
});

test("WindowsLocalBridgeDiscovery loads matching records from the local discovery directory", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "windows-local-discovery-"));
  const discoveryDir = path.join(tempDir, ".systemsculpt", "obsidian-automation");
  await fs.mkdir(discoveryDir, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(discoveryDir, "target.json"),
      JSON.stringify({
        pluginId: "systemsculpt-ai",
        vaultName: "SystemSculptWindowsQA",
        vaultPath: "C:/Users/TestUser/Documents/SystemSculptWindowsQA",
        port: 51870,
        token: "secret",
        startedAt: "2026-04-03T00:48:01.075Z",
      }),
      "utf8"
    ),
    fs.writeFile(
      path.join(discoveryDir, "other.json"),
      JSON.stringify({
        pluginId: "systemsculpt-ai",
        vaultName: "OtherVault",
        vaultPath: "C:/Users/TestUser/Documents/OtherVault",
        port: 60000,
        token: "other",
        startedAt: "2026-04-02T00:48:01.075Z",
      }),
      "utf8"
    ),
  ]);
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const discovery = new WindowsLocalBridgeDiscovery({ cacheTtlMs: 1_000 });
  const entries = await discovery.loadEntries({
    vaultName: "SystemSculptWindowsQA",
    vaultPath: "C:/Users/TestUser/Documents/SystemSculptWindowsQA",
    discoveryDir,
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].port, 51870);
  assert.equal(entries[0].token, "secret");
});
