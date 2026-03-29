#!/usr/bin/env node
import process from "node:process";
import {
  countConfiguredTargets,
  formatSyncTarget,
  loadConfiguredTargets,
  resolveSyncConfigPath,
  syncConfiguredTargets,
} from "./plugin-sync.mjs";

const usage = () => {
  console.log(`Usage: node scripts/sync-local-vaults.mjs [--config <path>]

Copies the built plugin artifacts (main.js, manifest.json, styles.css, etc.) into
configured Obsidian plugin folders. Targets can be local filesystem paths or
Windows SSH mirror targets defined in the configuration JSON. If --config is not
supplied, the script looks for the path in SYSTEMSCULPT_SYNC_CONFIG or defaults
to ./systemsculpt-sync.config.json.

Options:
  --config, -c <path>      Use a custom sync config JSON file.
  --allow-partial          Exit successfully when at least one target updates,
                           even if other targets fail. This is now the default.
  --strict                 Require every target to sync successfully.
  --count-targets          Print the resolved target count and exit.
  --list-targets           Print the resolved targets and exit.
  --help, -h               Show this help text.`);
};

function parseArgs(argv) {
  const options = {
    configPath: null,
    allowPartial: true,
    countTargets: false,
    listTargets: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === "--config" || arg === "-c") && index + 1 < argv.length) {
      options.configPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--allow-partial") {
      options.allowPartial = true;
      continue;
    }
    if (arg === "--strict") {
      options.allowPartial = false;
      continue;
    }
    if (arg === "--count-targets") {
      options.countTargets = true;
      continue;
    }
    if (arg === "--list-targets") {
      options.listTargets = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const configPath = resolveSyncConfigPath(options.configPath);

  if (options.countTargets) {
    process.stdout.write(String(countConfiguredTargets({ configPath })));
    return;
  }

  if (options.listTargets) {
    const loaded = loadConfiguredTargets({ configPath });
    for (const target of loaded.targets) {
      console.log(formatSyncTarget(target));
    }
    return;
  }

  const result = syncConfiguredTargets({
    configPath,
    allowPartial: options.allowPartial,
  });

  if (result.failed.length === 0) {
    console.log("[sync] Completed successfully.");
    return;
  }

  const failedTargets = result.failed.map((entry) => formatSyncTarget(entry.target)).join(", ");
  if (result.ok) {
    console.warn(`[sync] Completed with warnings. Failed targets: ${failedTargets}`);
    return;
  }

  throw new Error(`[sync] Failed targets: ${failedTargets}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error || "Unknown error"));
  process.exit(1);
});
