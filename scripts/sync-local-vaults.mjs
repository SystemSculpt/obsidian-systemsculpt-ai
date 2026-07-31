#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countConfiguredTargets,
  formatSyncTarget,
  loadConfiguredTargets,
  reloadConfiguredTargets,
  resolveSyncConfigPath,
  syncConfiguredTargets,
} from "./plugin-sync.mjs";
import {
  CANONICAL_API_BASE_URL,
  LOCAL_AGENT_API_BASE_URL,
  STAGING_API_BASE_URL,
} from "./plugin-build-options.mjs";

export function parseArgs(argv) {
  const options = {
    configPath: undefined,
    countTargets: false,
    listTargets: false,
    target: "production",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === "--config" || arg === "-c") && argv[index + 1]) {
      options.configPath = argv[index + 1];
      index += 1;
    } else if (arg === "--count-targets") {
      options.countTargets = true;
    } else if (arg === "--list-targets") {
      options.listTargets = true;
    } else if (arg === "--target" && argv[index + 1]) {
      options.target = argv[index + 1];
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["production", "staging", "local-agent"].includes(options.target)) {
    throw new Error(`Unknown plugin sync target: ${options.target}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/sync-local-vaults.mjs [--config <path>] [--target production|staging|local-agent]

Copies main.js, manifest.json, and styles.css into configured local Obsidian
pluginTargets, then reloads the plugin through the Obsidian CLI when available.

Options:
  --config, -c <path>  Use a custom sync config.
  --count-targets      Print the local target count.
  --list-targets       Print local targets.
  --target <name>      Validate and sync the production or staging API build.
  --help, -h           Show this help.`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
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
  const apiBaseUrl = options.target === "staging"
    ? STAGING_API_BASE_URL
    : options.target === "local-agent"
      ? LOCAL_AGENT_API_BASE_URL
      : CANONICAL_API_BASE_URL;
  const result = syncConfiguredTargets({ configPath, apiBaseUrl });
  reloadConfiguredTargets({ targets: result.succeeded });
  console.log("[sync] Completed successfully.");
}

const direct = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;

if (direct) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
