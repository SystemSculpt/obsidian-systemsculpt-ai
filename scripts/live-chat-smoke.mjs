#!/usr/bin/env node
// Bundles and runs the live managed-chat smoke (scripts/live-chat-smoke/entry.ts)
// against production. Requires a license key (SYSTEMSCULPT_LICENSE_KEY or a
// local QA vault); costs a few real chat turns. Never part of CI.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "systemsculpt-live-chat-smoke-"));
const outFile = path.join(outDir, "live-chat-smoke.cjs");

try {
  execFileSync("npx", [
    "esbuild",
    path.join(root, "scripts/live-chat-smoke/entry.ts"),
    "--bundle",
    "--platform=node",
    `--alias:obsidian=${path.join(root, "scripts/live-chat-smoke/obsidian-stub.ts")}`,
    `--outfile=${outFile}`,
    "--log-level=error",
  ], { cwd: root, stdio: "inherit" });
  execFileSync("node", [outFile], { cwd: root, stdio: "inherit" });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
