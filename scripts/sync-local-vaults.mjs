#!/usr/bin/env node
import process from "node:process";
import {
  countConfiguredTargets,
  formatSyncTarget,
  loadConfiguredTargets,
  reloadConfiguredTargets,
  resolveSyncConfigPath,
  syncConfiguredTargets,
} from "./plugin-sync.mjs";

function parseArgs(argv) {
  const options = { configPath: null, countTargets: false, listTargets: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === "--config" || arg === "-c") && argv[index + 1]) {
      options.configPath = argv[index + 1];
      index += 1;
    } else if (arg === "--count-targets") {
      options.countTargets = true;
    } else if (arg === "--list-targets") {
      options.listTargets = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/sync-local-vaults.mjs [--config <path>]

Copies main.js, manifest.json, and styles.css into configured local Obsidian
pluginTargets, then reloads the plugin through the Obsidian CLI when available.

Options:
  --config, -c <path>  Use a custom sync config.
  --count-targets      Print the local target count.
  --list-targets       Print local targets.
  --help, -h           Show this help.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const configPath = resolveSyncConfigPath(options.configPath);
  if (options.countTargets) {
    process.stdout.write(String(countConfiguredTargets({ configPath })));
    return;
  }
  if (options.listTargets) {
    for (const target of loadConfiguredTargets({ configPath }).targets) {
      console.log(formatSyncTarget(target));
    }
    return;
  }
  const result = syncConfiguredTargets({ configPath });
  reloadConfiguredTargets({ targets: result.succeeded });
  console.log("[sync] Completed successfully.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
