#!/usr/bin/env node
// Bundles and runs the live managed-chat smoke (scripts/live-chat-smoke/entry.ts)
// against production. Requires a license key (SYSTEMSCULPT_LICENSE_KEY or a
// local QA vault); costs a few real chat turns. Never part of CI.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

export const DEFAULT_LIVE_CHAT_SMOKE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function bundleLiveChatSmoke({
  root = DEFAULT_LIVE_CHAT_SMOKE_ROOT,
  outFile,
  buildImpl = buildSync,
} = {}) {
  if (!outFile) throw new Error("Live chat smoke bundling requires an output file.");
  const resolvedRoot = path.resolve(root);
  const resolvedOutput = path.resolve(outFile);
  buildImpl({
    absWorkingDir: resolvedRoot,
    entryPoints: [path.join(resolvedRoot, "scripts/live-chat-smoke/entry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: {
      obsidian: path.join(resolvedRoot, "scripts/live-chat-smoke/obsidian-stub.ts"),
    },
    outfile: resolvedOutput,
    logLevel: "error",
  });
  return resolvedOutput;
}

export function runLiveChatSmoke({
  args = process.argv.slice(2),
  root = DEFAULT_LIVE_CHAT_SMOKE_ROOT,
  buildImpl = buildSync,
  executeImpl = execFileSync,
  makeTemporaryDirectoryImpl = mkdtempSync,
  removeImpl = rmSync,
  log = console.log,
} = {}) {
  const unknown = args.filter((arg) => arg !== "--bundle-only");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);

  const resolvedRoot = path.resolve(root);
  const outDir = makeTemporaryDirectoryImpl(
    path.join(tmpdir(), "systemsculpt-live-chat-smoke-"),
  );
  const outFile = path.join(outDir, "live-chat-smoke.cjs");

  try {
    bundleLiveChatSmoke({ root: resolvedRoot, outFile, buildImpl });
    if (args.includes("--bundle-only")) {
      log("[smoke] Bundle preflight OK.");
      return Object.freeze({ bundleOnly: true, executed: false });
    }
    executeImpl(process.execPath, [outFile], {
      cwd: resolvedRoot,
      stdio: "inherit",
    });
    return Object.freeze({ bundleOnly: false, executed: true });
  } finally {
    removeImpl(outDir, { recursive: true, force: true });
  }
}

const direct = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (direct) {
  try {
    runLiveChatSmoke();
  } catch (error) {
    console.error(`[smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
