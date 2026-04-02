import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createWindowsSeedPluginData,
  prepareWindowsDesktopVault,
  readJsonIfExists,
  resolveWindowsHostedAuthSeed,
  upsertObsidianVaultRegistry,
} from "./common.mjs";
import {
  buildWindowsLaunchScript,
  buildWindowsTrustPromptDismissScript,
  sanitizeWindowsBootstrapReport,
} from "./bootstrap.mjs";

test("createWindowsSeedPluginData preserves existing values and forces bridge enablement", () => {
  const result = createWindowsSeedPluginData({
    settingsMode: "advanced",
    selectedModelId: "custom-model",
    vaultInstanceId: "fixed-vault",
    desktopAutomationBridgeEnabled: false,
  });

  assert.equal(result.settingsMode, "advanced");
  assert.equal(result.selectedModelId, "custom-model");
  assert.equal(result.vaultInstanceId, "fixed-vault");
  assert.equal(result.desktopAutomationBridgeEnabled, true);
});

test("upsertObsidianVaultRegistry marks the target vault open and clears older open flags", () => {
  const result = upsertObsidianVaultRegistry(
    {
      vaults: {
        oldvault: {
          path: "C:/Vaults/OldVault",
          ts: 1,
          open: true,
        },
      },
    },
    {
      vaultPath: "C:/Vaults/SystemSculptWindowsQA",
      vaultName: "SystemSculptWindowsQA",
      timestamp: 2,
    }
  );

  assert.equal(result.vaults.oldvault.open, false);
  assert.deepEqual(result.vaults.systemsculptwindowsqa, {
    path: path.resolve("C:/Vaults/SystemSculptWindowsQA"),
    ts: 2,
    open: true,
  });
});

test("resolveWindowsHostedAuthSeed reuses runtime smoke env conventions", () => {
  const seed = resolveWindowsHostedAuthSeed({
    SYSTEMSCULPT_E2E_LICENSE_KEY: "license-from-env",
    SYSTEMSCULPT_RUNTIME_SMOKE_SERVER_URL: "https://staging.systemsculpt.test",
  });

  assert.deepEqual(seed, {
    licenseKey: "license-from-env",
    licenseValid: true,
    enableSystemSculptProvider: true,
    serverUrl: "https://staging.systemsculpt.test",
    selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
    transcriptionProvider: "systemsculpt",
    embeddingsProvider: "systemsculpt",
  });
});

test("createWindowsSeedPluginData applies hosted auth seed when runtime smoke env is present", () => {
  const result = createWindowsSeedPluginData(
    {},
    {
      env: {
        SYSTEMSCULPT_RUNTIME_SMOKE_LICENSE_KEY: "runtime-license",
      },
    }
  );

  assert.equal(result.settingsMode, "advanced");
  assert.equal(result.licenseKey, "runtime-license");
  assert.equal(result.licenseValid, true);
  assert.equal(result.enableSystemSculptProvider, true);
  assert.equal(result.serverUrl, "https://api.systemsculpt.com");
  assert.equal(result.transcriptionProvider, "systemsculpt");
  assert.equal(result.embeddingsProvider, "systemsculpt");
});

test("prepareWindowsDesktopVault writes the fresh vault scaffold and generated sync config", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "windows-bootstrap-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const repoRoot = path.join(tempDir, "repo");
  const vaultPath = path.join(tempDir, "vault");
  const syncConfigPath = path.join(tempDir, "systemsculpt-sync.windows.generated.json");
  await fs.mkdir(repoRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(repoRoot, "manifest.json"), '{"id":"systemsculpt-ai","version":"5.3.0"}\n', "utf8"),
    fs.writeFile(path.join(repoRoot, "main.js"), "module.exports = {};\n", "utf8"),
    fs.writeFile(path.join(repoRoot, "styles.css"), "body {}\n", "utf8"),
  ]);

  const result = await prepareWindowsDesktopVault({
    repoRoot,
    vaultPath,
    vaultName: "SystemSculptWindowsQA",
    syncConfigPath,
  });

  const communityPlugins = await readJsonIfExists(path.join(vaultPath, ".obsidian", "community-plugins.json"));
  const pluginData = await readJsonIfExists(path.join(result.pluginDir, "data.json"));
  const syncConfig = await readJsonIfExists(syncConfigPath);

  assert.deepEqual(communityPlugins, ["systemsculpt-ai"]);
  assert.equal(pluginData.selectedModelId, "systemsculpt@@systemsculpt/ai-agent");
  assert.equal(pluginData.desktopAutomationBridgeEnabled, true);
  assert.equal(pluginData.settingsMode, "advanced");
  assert.equal(syncConfig.pluginTargets[0].path, result.pluginDir);
});

test("readJsonIfExists accepts BOM-prefixed JSON files", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "windows-bootstrap-bom-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const filePath = path.join(tempDir, "bom.json");
  await fs.writeFile(filePath, "\ufeff{\"ok\":true}\n", "utf8");

  const parsed = await readJsonIfExists(filePath);
  assert.deepEqual(parsed, { ok: true });
});

test("buildWindowsLaunchScript injects the clean Pi agent dir and env clearing list", () => {
  const script = buildWindowsLaunchScript({
    obsidianExe: "C:/Obsidian/Obsidian.exe",
    piAgentDir: "C:/Vaults/SystemSculptWindowsQA/.systemsculpt/pi-empty-agent",
    vaultPath: "C:/Vaults/SystemSculptWindowsQA",
    resultPath: "C:/Windows/Temp/obsidian-launch.json",
    clearedEnvKeys: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
  });

  assert.match(script, /PI_CODING_AGENT_DIR/);
  assert.match(script, /OPENAI_API_KEY/);
  assert.match(script, /ANTHROPIC_API_KEY/);
  assert.match(script, /SystemSculptWindowsQA/);
  assert.match(script, /foreach \(\$name in @\("OPENAI_API_KEY", "ANTHROPIC_API_KEY"\)\)/);
  assert.match(script, /ArgumentList @\(\$vaultPath\)/);
});

test("buildWindowsTrustPromptDismissScript looks for the trust prompt and enable button", () => {
  const script = buildWindowsTrustPromptDismissScript({
    resultPath: "C:/Windows/Temp/obsidian-trust.json",
    timeoutMs: 12000,
  });

  assert.match(script, /UIAutomationClient/);
  assert.match(script, /Do you trust the author of this vault\?/);
  assert.match(script, /Trust author and enable plugins/);
  assert.match(script, /InvokePattern/);
  assert.match(script, /SendKeys/);
  assert.match(script, /obsidian-trust\.json/);
});

test("sanitizeWindowsBootstrapReport redacts sensitive plugin data before printing", () => {
  const sanitized = sanitizeWindowsBootstrapReport({
    pluginData: {
      settingsMode: "advanced",
      selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
      licenseKey: "license-123",
      userEmail: "mike@example.com",
      userName: "mike@example.com",
      displayName: "Mike",
      openAiApiKey: "sk-test",
      readwiseApiToken: "rw-test",
      customProviders: [
        {
          id: "provider-1",
          apiKey: "cp-test",
          label: "Custom Provider",
        },
      ],
    },
    launch: {
      ok: true,
      vaultPath: "C:/Vaults/SystemSculptWindowsQA",
    },
  });

  assert.equal(sanitized.pluginData.settingsMode, "advanced");
  assert.equal(sanitized.pluginData.selectedModelId, "systemsculpt@@systemsculpt/ai-agent");
  assert.equal(sanitized.pluginData.licenseKey, "[REDACTED]");
  assert.equal(sanitized.pluginData.userEmail, "[REDACTED]");
  assert.equal(sanitized.pluginData.userName, "[REDACTED]");
  assert.equal(sanitized.pluginData.displayName, "[REDACTED]");
  assert.equal(sanitized.pluginData.openAiApiKey, "[REDACTED]");
  assert.equal(sanitized.pluginData.readwiseApiToken, "[REDACTED]");
  assert.equal(sanitized.pluginData.customProviders[0].apiKey, "[REDACTED]");
  assert.equal(sanitized.launch.vaultPath, "C:/Vaults/SystemSculptWindowsQA");
});
