#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { bootstrapDesktopAutomationClient } from "../testing/native/desktop-automation/bootstrap.mjs";
import { createDesktopAutomationClient } from "../testing/native/desktop-automation/client.mjs";

function parseArgs(argv) {
  const options = {
    pluginId: String(process.env.SYSTEMSCULPT_OBSIDIAN_PLUGIN_ID || "systemsculpt-ai").trim() || "systemsculpt-ai",
    syncConfigPath: path.resolve(process.cwd(), "systemsculpt-sync.config.json"),
    targetIndex: null,
    vaultName: "",
    vaultPath: "",
    timeoutMs: null,
    quietUnavailable: false,
    quietSuccess: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plugin-id") {
      options.pluginId = String(argv[index + 1] || "").trim() || options.pluginId;
      index += 1;
      continue;
    }
    if (arg === "--sync-config") {
      options.syncConfigPath = path.resolve(String(argv[index + 1] || "").trim() || options.syncConfigPath);
      index += 1;
      continue;
    }
    if (arg === "--target-index") {
      const parsed = Number.parseInt(String(argv[index + 1] || ""), 10);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid value for --target-index: ${String(argv[index + 1] || "")}`);
      }
      options.targetIndex = parsed;
      index += 1;
      continue;
    }
    if (arg === "--vault-name") {
      options.vaultName = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--vault-path") {
      options.vaultPath = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      const parsed = Number.parseInt(String(argv[index + 1] || ""), 10);
      options.timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      index += 1;
      continue;
    }
    if (arg === "--quiet-unavailable") {
      options.quietUnavailable = true;
      continue;
    }
    if (arg === "--quiet-success") {
      options.quietSuccess = true;
      continue;
    }
  }

  return options;
}

function hasExplicitTargetSelection(options) {
  return (
    options.targetIndex !== null ||
    String(options.vaultName || "").trim().length > 0 ||
    String(options.vaultPath || "").trim().length > 0
  );
}

async function inferTargetFromLiveBridge(options) {
  if (hasExplicitTargetSelection(options)) {
    return options;
  }

  const client = await createDesktopAutomationClient({
    pluginId: options.pluginId,
  });
  const liveVaultPath = String(client.record?.vaultPath || "").trim();
  const liveVaultName = String(client.record?.vaultName || "").trim();

  if (!liveVaultPath && !liveVaultName) {
    throw new Error(
      "A live desktop automation bridge was found, but it did not report a vault selector."
    );
  }

  return {
    ...options,
    vaultPath: liveVaultPath || options.vaultPath,
    vaultName: liveVaultName || options.vaultName,
  };
}

async function main() {
  const parsedOptions = parseArgs(process.argv.slice(2));
  let resolvedOptions = null;
  try {
    resolvedOptions = await inferTargetFromLiveBridge(parsedOptions);
    const bootstrap = await bootstrapDesktopAutomationClient({
      pluginId: resolvedOptions.pluginId,
      syncConfigPath: resolvedOptions.syncConfigPath,
      targetIndex: resolvedOptions.targetIndex,
      vaultName: resolvedOptions.vaultName,
      vaultPath: resolvedOptions.vaultPath,
      reload: true,
      timeoutMs: resolvedOptions.timeoutMs || (resolvedOptions.quietUnavailable ? 8000 : undefined),
    });

    if (!resolvedOptions.quietSuccess) {
      console.log(
        `[reload] Reloaded ${resolvedOptions.pluginId} in ${bootstrap.target.vaultName} via ${bootstrap.reload.method}` +
          (bootstrap.client.record?.startedAt
            ? ` (bridge started ${bootstrap.client.record.startedAt})`
            : "")
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Unknown error");
    if (
      (resolvedOptions?.quietUnavailable || parsedOptions.quietUnavailable) &&
      /No live desktop automation bridge|No plugin targets|external settings sync|manual plugin reload once|did not report a vault selector/i.test(
        message
      )
    ) {
      process.exit(0);
    }
    console.error(`[reload] Failed to reload Obsidian plugin: ${message}`);
    process.exitCode = 1;
  }
}

await main();
