import test from "node:test";
import assert from "node:assert/strict";
import {
  buildListWindowsBridgeRecordsScript,
  parseArgs,
  parseRemoteBridgeRecords,
  selectLatestRemoteBridgeRecord,
} from "./run-desktop-automation.mjs";

test("parseArgs accepts the Windows SSH host and no-local-Pi override", () => {
  const parsed = parseArgs([
    "--case",
    "chatview-stress",
    "--host",
    "custom-windows-host",
    "--allow-local-pi",
    "--no-reload",
  ]);

  assert.equal(parsed.caseName, "chatview-stress");
  assert.equal(parsed.sshHost, "custom-windows-host");
  assert.equal(parsed.allowLocalPi, true);
  assert.equal(parsed.reload, false);
});

test("buildListWindowsBridgeRecordsScript enumerates the Windows discovery directory", () => {
  const script = buildListWindowsBridgeRecordsScript();

  assert.match(script, /\.systemsculpt\/obsidian-automation/);
  assert.match(script, /pluginId -eq 'systemsculpt-ai'/);
  assert.match(script, /ConvertTo-Json -Compress -Depth 5/);
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
