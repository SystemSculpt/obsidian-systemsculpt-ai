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
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(__dirname, "git-hooks");
const targetDir = path.join(repoRoot, ".git", "hooks");

// Guard: only run inside a git repo (CI `--ignore-scripts` skips this anyway)
if (!fs.existsSync(targetDir)) {
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
