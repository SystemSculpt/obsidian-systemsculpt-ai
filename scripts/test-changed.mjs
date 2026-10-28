#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRepositoryScopedGitEnvironment } from "./repository-git.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

export function moneySuites(repoRoot = root) {
  const suites = [
    "src/core/license/__tests__/LicenseManager.test.ts",
    "src/services/__tests__/LicenseService.test.ts",
    "src/services/credits/__tests__/CreditsBalanceCache.test.ts",
    ...fs.readdirSync(path.join(repoRoot, "src/services/__tests__"))
      .filter((name) => /^SystemSculptService\.credits-.*\.test\.ts$/.test(name))
      .sort()
      .map((name) => `src/services/__tests__/${name}`),
    "src/modals/__tests__/CreditsBalanceModal.test.ts",
    "src/modals/__tests__/UpgradePlanModal.test.ts",
    "src/core/plugin/__tests__/commands-credits.test.ts",
    "src/__tests__/main-credits-balance-modal.test.ts",
    "src/views/chatview/__tests__/agent-chat-view-credits-cache.test.ts",
    "src/utils/__tests__/licenseUtils.test.ts",
  ];
  if (!suites.some((file) => file.includes("SystemSculptService.credits-"))) {
    throw new Error("Missing SystemSculptService credits suites");
  }
  for (const file of suites) {
    if (!fs.existsSync(path.join(repoRoot, file))) throw new Error(`Missing money suite: ${file}`);
  }
  return suites;
}

export function changedTestCommands(changedFiles, money = moneySuites()) {
  const sourceFiles = changedFiles.filter((file) => file.startsWith("src/"));
  const commands = [[
    "scripts/jest.mjs", "--strict-console", "--config", "jest.config.cjs",
    "--findRelatedTests", ...new Set([...sourceFiles, ...money]), "--passWithNoTests",
  ]];
  if (sourceFiles.some((file) => file.startsWith("src/services/embeddings/"))) {
    commands.push([
      "scripts/jest.mjs", "--strict-console", "--config", "jest.embeddings.config.cjs",
      "--findRelatedTests", ...sourceFiles, "--passWithNoTests",
    ]);
  }
  if (changedFiles.some((file) => file.startsWith("testing/integration/")
    || file === "esbuild.config.mjs" || file === "manifest.json")) {
    commands.push([
      "scripts/jest.mjs", "--strict-console", "--config", "jest.integration.config.cjs",
      "--runInBand", "--detectOpenHandles", "--openHandlesTimeout=1000", "--randomize", "--showSeed",
    ]);
  }
  return commands;
}

export function runChangedTests() {
  const env = createRepositoryScopedGitEnvironment();
  const changedFiles = execFileSync("git", ["diff", "--name-only", "-z", "origin/main...HEAD"], {
    cwd: root, encoding: "utf8", env,
  }).split("\0").filter(Boolean);
  const money = moneySuites();
  console.log(`[tests] Always-run money suites:\n${money.join("\n")}`);
  console.log(`[tests] Changed files: ${changedFiles.length}`);
  for (const args of changedTestCommands(changedFiles, money)) {
    const child = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env });
    if (child.error) throw child.error;
    if (child.status !== 0) return child.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runChangedTests();
}
