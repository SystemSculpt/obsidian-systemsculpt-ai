#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(message);
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    fail(`Missing value for ${flag}.`);
  }
  return value;
}

function usage() {
  console.log(`Usage: node testing/native/device/ios/sanitize-canary-diagnostics.mjs [options]

Create a public-safe iOS canary diagnostic summary.

Options:
  --preflight <path>  Raw preflight JSON to summarize
  --runtime <path>    Raw runtime-smoke JSON to summarize
  --output <path>     Output JSON path
  --help, -h          Show this help.`);
}

export function parseArgs(argv) {
  const options = {
    preflightPath: "",
    runtimePath: "",
    outputPath: "",
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--preflight") {
      options.preflightPath = String(requireValue(argv, index, arg)).trim();
      index += 1;
      continue;
    }
    if (arg === "--runtime") {
      options.runtimePath = String(requireValue(argv, index, arg)).trim();
      index += 1;
      continue;
    }
    if (arg === "--output") {
      options.outputPath = String(requireValue(argv, index, arg)).trim();
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }

  if (!options.help && !options.preflightPath && !options.runtimePath) {
    fail("Pass --preflight, --runtime, or both.");
  }
  if (!options.help && !options.outputPath) {
    fail("Pass --output.");
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8"));
}

function sanitizeText(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return text
    .replace(/\/Users\/[^/\s"'`]+(?:\/[^\s"'`]*)?/g, "[local-path]")
    .replace(/\/private\/var\/[^\s"'`]+/g, "[local-path]")
    .replace(/\/var\/folders\/[^\s"'`]+/g, "[local-path]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+(?:\\[^\\\s"'`]*)?/g, "[local-path]")
    .replace(/https?:\/\/[^\s"'`]+/g, "[url]");
}

export function sanitizePreflightDiagnostics(preflight) {
  const config = preflight?.config || null;
  const tools = preflight?.tools || {};
  const device = preflight?.device || {};

  return {
    ok: preflight?.ok === true,
    config: config
      ? {
          pluginTargets: Number(config.pluginTargets) || 0,
          mirrorTargets: Number(config.mirrorTargets) || 0,
        }
      : null,
    tools: {
      xcode: Boolean(tools.xcodePath),
      xcrun: Boolean(tools.xcrunPath),
      webkitAdapter: Boolean(tools.remotedebugIosWebkitAdapterPath),
    },
    device: {
      platform: sanitizeText(device.platform),
      osVersion: sanitizeText(device.osVersion),
      transportType: sanitizeText(device.transportType) || null,
      tunnelState: sanitizeText(device.tunnelState) || null,
      developerModeStatus: sanitizeText(device.developerModeStatus) || null,
    },
  };
}

export function sanitizeRuntimeSmokeDiagnostics(runtime) {
  const iterations = Array.isArray(runtime?.iterations) ? runtime.iterations : [];

  return {
    mode: sanitizeText(runtime?.mode),
    hostedAuthBootstrapped: runtime?.hostedAuthBootstrapped === true,
    repeat: Number(runtime?.repeat) || iterations.length || 0,
    iterations: iterations.map((iteration) => {
      const results = iteration?.results && typeof iteration.results === "object"
        ? iteration.results
        : {};
      return {
        iteration: Number(iteration?.iteration) || 0,
        cases: Object.entries(results).map(([caseName, result]) => ({
          name: sanitizeText(caseName),
          ok: result?.ok !== false,
          attemptsUsed: Number(result?.attemptsUsed) || 0,
          durationMs: Number(result?.durationMs) || 0,
        })),
      };
    }),
  };
}

export function buildSanitizedCanaryDiagnostics({ preflight = null, runtime = null } = {}) {
  return {
    schemaVersion: 1,
    preflight: preflight ? sanitizePreflightDiagnostics(preflight) : null,
    runtime: runtime ? sanitizeRuntimeSmokeDiagnostics(runtime) : null,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const payload = buildSanitizedCanaryDiagnostics({
    preflight: options.preflightPath ? readJson(options.preflightPath) : null,
    runtime: options.runtimePath ? readJson(options.runtimePath) : null,
  });
  fs.writeFileSync(
    path.resolve(process.cwd(), options.outputPath),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

const isDirectExecution = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isDirectExecution) {
  try {
    main();
  } catch (error) {
    console.error(`[ios-canary] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
