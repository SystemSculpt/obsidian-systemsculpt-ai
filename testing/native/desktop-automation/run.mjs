#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runDesktopAutomation } from "./runner.mjs";
import {
  DEFAULT_FIXTURE_DIR,
  DEFAULT_PAUSE_MS,
  DEFAULT_REPEAT,
  DEFAULT_WEB_FETCH_URL,
  DEFAULT_YOUTUBE_URL,
} from "../runtime-smoke/constants.mjs";

function usage() {
  console.log(`Usage: node testing/native/desktop-automation/run.mjs [options]

Run no-focus desktop automation against the already-running Obsidian vault by
talking to the plugin's localhost bridge instead of driving the renderer.

Options:
  --case <name|all|extended|stress|soak>   Case list: setup-baseline, managed-baseline, provider-connected-baseline, model-switch, chat-exact, file-read, file-write, web-fetch, youtube-transcript, reload-stress, chatview-stress, all, extended, stress, or soak. Default: all
  --sync-config <path>         Sync config used to resolve the desktop plugin target. Default: ./systemsculpt-sync.config.json
  --target-index <n>           Pin a pluginTargets entry from the sync config
  --vault-name <name>          Pin a specific sync target by vault name
  --vault-path <path>          Pin a specific sync target by absolute vault path
  --fixture-dir <path>         Vault-relative fixture folder. Default: ${DEFAULT_FIXTURE_DIR}
  --web-fetch-url <url>        URL for the direct web-fetch bridge case. Default: ${DEFAULT_WEB_FETCH_URL}
  --youtube-url <url>          URL for the direct YouTube transcript bridge case. Default: ${DEFAULT_YOUTUBE_URL}
  --repeat <n>                 Repeat the selected cases. Default: ${DEFAULT_REPEAT}
  --pause-ms <n>               Delay between iterations. Default: ${DEFAULT_PAUSE_MS}
  --json-output <path>         Write the final JSON report to this path as well as stdout
  --no-reload                  Reuse a live bridge if one already exists instead of forcing a plugin reload
  --allow-single-model-fallback
                               Allow fresh-install fallback coverage when only one authenticated model exists
  --help, -h                   Show this help

When no target selector is supplied, the runner prefers the latest live bridge
target and falls back to the first synced desktop target only if no live bridge
can be matched.
`);
}

function fail(message) {
  console.error(`[desktop-automation] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    caseName: "all",
    syncConfigPath: path.resolve(process.cwd(), "systemsculpt-sync.config.json"),
    targetIndex: null,
    vaultName: "",
    vaultPath: "",
    fixtureDir: DEFAULT_FIXTURE_DIR,
    webFetchUrl: DEFAULT_WEB_FETCH_URL,
    youtubeUrl: DEFAULT_YOUTUBE_URL,
    repeat: DEFAULT_REPEAT,
    pauseMs: DEFAULT_PAUSE_MS,
    jsonOutput: "",
    reload: true,
    allowSingleModelFallback: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--case") {
      options.caseName = String(argv[index + 1] || "").trim() || options.caseName;
      index += 1;
      continue;
    }
    if (arg === "--sync-config") {
      options.syncConfigPath = path.resolve(String(argv[index + 1] || "") || options.syncConfigPath);
      index += 1;
      continue;
    }
    if (arg === "--target-index") {
      const parsedTargetIndex = Number.parseInt(String(argv[index + 1] || ""), 10);
      if (!Number.isFinite(parsedTargetIndex)) {
        fail(`Invalid value for --target-index: ${String(argv[index + 1] || "")}`);
      }
      options.targetIndex = parsedTargetIndex;
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
    if (arg === "--fixture-dir") {
      options.fixtureDir = String(argv[index + 1] || "").trim() || options.fixtureDir;
      index += 1;
      continue;
    }
    if (arg === "--web-fetch-url") {
      options.webFetchUrl = String(argv[index + 1] || "").trim() || options.webFetchUrl;
      index += 1;
      continue;
    }
    if (arg === "--youtube-url") {
      options.youtubeUrl = String(argv[index + 1] || "").trim() || options.youtubeUrl;
      index += 1;
      continue;
    }
    if (arg === "--repeat") {
      const parsedRepeat = Number.parseInt(String(argv[index + 1] || ""), 10);
      options.repeat = Math.max(1, Number.isFinite(parsedRepeat) ? parsedRepeat : options.repeat);
      index += 1;
      continue;
    }
    if (arg === "--pause-ms") {
      const parsedPauseMs = Number.parseInt(String(argv[index + 1] || ""), 10);
      options.pauseMs = Math.max(0, Number.isFinite(parsedPauseMs) ? parsedPauseMs : options.pauseMs);
      index += 1;
      continue;
    }
    if (arg === "--json-output") {
      options.jsonOutput = path.resolve(String(argv[index + 1] || "").trim());
      index += 1;
      continue;
    }
    if (arg === "--no-reload") {
      options.reload = false;
      continue;
    }
    if (arg === "--allow-single-model-fallback") {
      options.allowSingleModelFallback = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }

    fail(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = await runDesktopAutomation(options);
  console.log(JSON.stringify(payload, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
