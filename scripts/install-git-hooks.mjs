#!/usr/bin/env node
/**
 * install-git-hooks.mjs
 *
 * Copies version-controlled hooks from scripts/git-hooks/ into .git/hooks/
 * so they run automatically on every commit. Called by the npm "prepare"
 * lifecycle script after `npm install` / `npm ci`.
 *
 * Safe to run repeatedly - existing hooks that were NOT installed by this
 * script are left untouched (a warning is printed instead).
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(__dirname, "git-hooks");
let targetDir = null;
try {
  const resolved = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  targetDir = path.isAbsolute(resolved) ? resolved : path.resolve(repoRoot, resolved);
} catch {
  // Package archives and CI source snapshots may not have Git metadata.
}

// Guard: only run inside a Git checkout with an existing hooks directory.
if (!targetDir || !fs.existsSync(targetDir)) {
  process.exit(0);
}

const SENTINEL = "# installed-by: install-git-hooks.mjs";

for (const entry of fs.readdirSync(sourceDir)) {
  const src = path.join(sourceDir, entry);
  const dest = path.join(targetDir, entry);

  if (!fs.statSync(src).isFile()) continue;

  // Do not overwrite a user-authored hook
  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, "utf8");
    if (!existing.includes(SENTINEL) && !existing.includes(".sample")) {
      console.warn(`[git-hooks] Skipping ${entry} - custom hook already exists`);
      continue;
    }
  }

  const raw = fs.readFileSync(src, "utf8");
  // Preserve the shebang on line 1 so the kernel can exec the hook on Linux.
  const shebangMatch = raw.match(/^(#!.*\n)/);
  const content = shebangMatch
    ? shebangMatch[1] + SENTINEL + "\n" + raw.slice(shebangMatch[0].length)
    : SENTINEL + "\n" + raw;
  fs.writeFileSync(dest, content, { mode: 0o755 });
  console.log(`[git-hooks] Installed ${entry}`);
}
