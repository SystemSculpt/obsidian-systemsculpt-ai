#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { bootstrapObsidianReloadClient } from "./obsidian-reload/bootstrap.mjs";

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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    const bootstrap = await bootstrapObsidianReloadClient({
      pluginId: options.pluginId,
      syncConfigPath: options.syncConfigPath,
      targetIndex: options.targetIndex,
      vaultName: options.vaultName,
      vaultPath: options.vaultPath,
      timeoutMs: options.timeoutMs || (options.quietUnavailable ? 8000 : undefined),
    });

    if (!options.quietSuccess) {
      console.log(
        `[reload] Reloaded ${options.pluginId} in ${bootstrap.target.vaultName} via ${bootstrap.reload.method}` +
          (bootstrap.client.record?.startedAt
            ? ` (bridge started ${bootstrap.client.record.startedAt})`
            : "")
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Unknown error");
    if (
      options.quietUnavailable &&
      /Obsidian reload is unavailable|No local Obsidian plugin targets|manual plugin reload/i.test(
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
