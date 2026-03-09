#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cwd = process.cwd();
const args = process.argv.slice(2);
const PI_RUNTIME_DIR = path.join(cwd, "dist", "pi-runtime");
const PI_RUNTIME_MANIFEST_NAME = "studio-pi-runtime-manifest.json";
const TERMINAL_RUNTIME_DIR = path.join(cwd, "dist", "terminal-runtime");
const TERMINAL_RUNTIME_MANIFEST_NAME = "studio-terminal-runtime-manifest.json";

function parseArgs(argv) {
  const options = {
    bump: null,
    version: null,
    draft: false,
    dryRun: false,
    skipChecks: false,
    allowDirty: false,
    notesFile: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--draft") {
      options.draft = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--skip-checks") {
      options.skipChecks = true;
      continue;
    }
    if (arg === "--allow-dirty") {
      options.allowDirty = true;
      continue;
    }
    if (arg === "--bump") {
      const value = argv[i + 1];
      if (!value) {
        fail("Missing value for --bump (major|minor|patch).");
      }
      options.bump = value;
      i += 1;
      continue;
    }
    if (arg === "--version") {
      const value = argv[i + 1];
      if (!value) {
        fail("Missing value for --version (x.y.z).");
      }
      options.version = value;
      i += 1;
      continue;
    }
    if (arg === "--notes-file") {
      const value = argv[i + 1];
      if (!value) {
        fail("Missing value for --notes-file.");
      }
      options.notesFile = value;
      i += 1;
      continue;
    }

    fail(`Unknown argument: ${arg}`);
  }

  if (options.bump && options.version) {
    fail("Use either --bump or --version, not both.");
  }

  if (options.bump && !["major", "minor", "patch"].includes(options.bump)) {
    fail("--bump must be one of: major, minor, patch.");
  }

  if (options.version && !isSemver(options.version)) {
    fail("--version must match x.y.z");
  }

  return options;
}

function run(command, commandArgs, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      fail(`Required command not found: ${command}`);
    }
    if (!allowFailure) {
      throw result.error;
    }
  }

  const status = result.status ?? 1;
  if (status !== 0 && !allowFailure) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    const details = stderr || stdout;
    fail(`${command} ${commandArgs.join(" ")} failed.${details ? `\n${details}` : ""}`);
  }

  return {
    status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function runCapture(command, commandArgs, allowFailure = false) {
  return run(command, commandArgs, { capture: true, allowFailure });
}

function logStep(message) {
  console.log(`[release] ${message}`);
}

function fail(message) {
  console.error(`[release] ERROR: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+$/.test(value);
}

function parseSemver(value) {
  if (!isSemver(value)) {
    fail(`Invalid semver: ${value}`);
  }
  const [major, minor, patch] = value.split(".").map((part) => Number(part));
  return { major, minor, patch };
}

function incrementVersion(currentVersion, bump) {
  const parsed = parseSemver(currentVersion);
  if (bump === "major") {
    return `${parsed.major + 1}.0.0`;
  }
  if (bump === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function inferBump(commits) {
  const subjects = commits.map((commit) => commit.subject);

  const hasMajor = subjects.some((subject) => {
    return /breaking change/i.test(subject)
      || /\bbreaking\b/i.test(subject)
      || /^[a-z]+(?:\([^)]*\))?!:/i.test(subject);
  });
  if (hasMajor) {
    return "major";
  }

  const hasMinor = subjects.some((subject) => {
    return /^feat(?:\([^)]*\))?!?:/i.test(subject) || /\bfeature\b/i.test(subject);
  });
  if (hasMinor) {
    return "minor";
  }

  return "patch";
}

function toSentence(subject) {
  const normalized = subject
    .replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim();

  if (!normalized) {
    return "Internal update.";
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function shouldSkipInNotes(subject) {
  const value = subject.trim().toLowerCase();
  return value.startsWith("merge ")
    || value.startsWith("release:")
    || value.startsWith("chore(release)")
    || value.startsWith("ci:")
    || value.startsWith("build:")
    || value.startsWith("chore(ci)");
}

function buildReleaseNotes(version, commits) {
  const features = [];
  const fixes = [];
  const improvements = [];

  for (const commit of commits) {
    const subject = commit.subject;
    if (shouldSkipInNotes(subject)) {
      continue;
    }

    const line = `- ${toSentence(subject)}`;
    if (/^feat(?:\([^)]*\))?!?:/i.test(subject)) {
      features.push(line);
      continue;
    }
    if (/^fix(?:\([^)]*\))?!?:/i.test(subject)) {
      fixes.push(line);
      continue;
    }

    improvements.push(line);
  }

  const finalFeatures = features.length > 0 ? features : ["- No headline feature commits were detected in this range."];
  const finalFixes = fixes.length > 0 ? fixes : ["- No dedicated fix commits were detected in this range."];
  const finalImprovements = improvements.length > 0 ? improvements : ["- Internal maintenance and quality updates."];

  return [
    `## What's New in ${version}`,
    "",
    "### ✨ New Features",
    ...finalFeatures,
    "",
    "### 🐛 Bug Fixes",
    ...finalFixes,
    "",
    "### 🔧 Improvements",
    ...finalImprovements,
  ].join("\n");
}

function getRepoRoot() {
  const result = runCapture("git", ["rev-parse", "--show-toplevel"]);
  return result.stdout;
}

function ensureExpectedFiles() {
  const required = ["README.md", "LICENSE", "manifest.json", "package.json", "package-lock.json", "versions.json"];
  for (const file of required) {
    const abs = path.join(cwd, file);
    if (!fs.existsSync(abs)) {
      fail(`Required file missing: ${file}`);
    }
  }
}

function ensureCleanTree(allowDirty) {
  const status = runCapture("git", ["status", "--porcelain"]).stdout;
  if (status && !allowDirty) {
    fail("Working tree is not clean. Commit or stash your changes before running release.");
  }
  if (status && allowDirty) {
    logStep("Working tree is dirty but --allow-dirty was supplied (continuing).");
  }
}

function getLastTag() {
  const result = runCapture("git", ["describe", "--tags", "--abbrev=0"], true);
  return result.status === 0 ? result.stdout : "";
}

function getCommitsSince(lastTag) {
  const argsForLog = lastTag
    ? ["log", `${lastTag}..HEAD`, "--pretty=format:%h%x09%s"]
    : ["log", "--pretty=format:%h%x09%s"];

  const out = runCapture("git", argsForLog).stdout;
  if (!out) {
    return [];
  }

  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, ...subjectParts] = line.split("\t");
      return {
        hash: hash.trim(),
        subject: subjectParts.join("\t").trim(),
      };
    });
}

function ensureTagDoesNotExist(version) {
  const localTag = runCapture("git", ["rev-parse", "-q", "--verify", `refs/tags/${version}`], true);
  if (localTag.status === 0) {
    fail(`Tag already exists locally: ${version}`);
  }

  const remoteTag = runCapture("git", ["ls-remote", "--tags", "origin", `refs/tags/${version}`], true);
  if (remoteTag.stdout) {
    fail(`Tag already exists on origin: ${version}`);
  }
}

function ensureGitHubCliReady() {
  const auth = runCapture("gh", ["auth", "status"], true);
  if (auth.status !== 0) {
    const details = auth.stderr || auth.stdout || "Run `gh auth login` before releasing.";
    fail(`GitHub CLI is not authenticated for release creation.\n${details}`);
  }
}

function updateReadmeVersion(readmePath, newVersion) {
  const existing = fs.readFileSync(readmePath, "utf8");
  let updated = existing;

  updated = updated.replace(
    /(- Plugin version:\s*`)(\d+\.\d+\.\d+)(`)/,
    `$1${newVersion}$3`
  );

  updated = updated.replace(
    /(img\.shields\.io\/badge\/version-)(\d+\.\d+\.\d+)(-blue\.svg)/g,
    `$1${newVersion}$3`
  );

  if (updated !== existing) {
    fs.writeFileSync(readmePath, updated, "utf8");
  }
}

function printPlan({
  currentVersion,
  newVersion,
  bump,
  lastTag,
  commitCount,
  dryRun,
}) {
  console.log("\n[release] Plan");
  console.log(`[release] - Current version: ${currentVersion}`);
  console.log(`[release] - Next version: ${newVersion} (${bump})`);
  console.log(`[release] - Last tag: ${lastTag || "(none)"}`);
  console.log(`[release] - Commits included: ${commitCount}`);
  console.log("[release] - Local GitHub draft release via gh: yes");
  console.log("[release] - Windows validation: manual risk accepted");
  console.log(`[release] - Dry run: ${dryRun ? "yes" : "no"}`);
}

function writeNotesFile(version, commits, customNotesFile) {
  if (customNotesFile) {
    const resolvedNotesPath = path.resolve(cwd, customNotesFile);
    if (!fs.existsSync(resolvedNotesPath)) {
      fail(`Notes file does not exist: ${resolvedNotesPath}`);
    }
    return resolvedNotesPath;
  }

  const notes = buildReleaseNotes(version, commits);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-release-"));
  const notesPath = path.join(tempDir, `${version}.md`);
  fs.writeFileSync(notesPath, `${notes}\n`, "utf8");
  return notesPath;
}

function runChecks(skipChecks) {
  if (skipChecks) {
    logStep("Skipping checks (--skip-checks).");
    return;
  }

  logStep("Running npm run check:plugin");
  run("npm", ["run", "check:plugin"]);

  logStep("Running npm run check:e2e");
  run("npm", ["run", "check:e2e"]);

  logStep("Running npm test");
  run("npm", ["test"]);

  logStep("Running npm run build");
  run("npm", ["run", "build"]);

  logStep("Running npm run build:pi-runtime");
  run("npm", ["run", "build:pi-runtime"]);

  logStep("Running npm run verify:pi-runtime");
  run("npm", ["run", "verify:pi-runtime"]);

  logStep("Running npm run build:terminal-runtime");
  run("npm", ["run", "build:terminal-runtime"]);
}

function collectPiRuntimeAssets() {
  const manifestPath = path.join(PI_RUNTIME_DIR, PI_RUNTIME_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    fail(`Required release asset missing after build: ${path.relative(cwd, manifestPath)}`);
  }

  const manifest = readJson(manifestPath);
  const assets = manifest?.assets;
  if (!assets || typeof assets !== "object") {
    fail(`Pi runtime manifest is invalid: ${path.relative(cwd, manifestPath)}`);
  }

  const runtimeFiles = [];
  for (const target of Object.keys(assets).sort()) {
    const fileName = String(assets[target]?.fileName || "").trim();
    if (!fileName) {
      fail(`Pi runtime manifest entry for ${target} is missing fileName.`);
    }
    const assetPath = path.join(PI_RUNTIME_DIR, fileName);
    if (!fs.existsSync(assetPath)) {
      fail(`Pi runtime asset missing for ${target}: ${path.relative(cwd, assetPath)}`);
    }
    runtimeFiles.push(path.relative(cwd, assetPath));
  }

  return {
    manifestFile: path.relative(cwd, manifestPath),
    runtimeFiles,
  };
}

function collectTerminalRuntimeAssets() {
  const manifestPath = path.join(TERMINAL_RUNTIME_DIR, TERMINAL_RUNTIME_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    fail(`Required release asset missing after build: ${path.relative(cwd, manifestPath)}`);
  }

  const manifest = readJson(manifestPath);
  const assets = manifest?.assets;
  if (!assets || typeof assets !== "object") {
    fail(`Terminal runtime manifest is invalid: ${path.relative(cwd, manifestPath)}`);
  }

  const runtimeFiles = [];
  for (const target of Object.keys(assets).sort()) {
    const fileName = String(assets[target]?.fileName || "").trim();
    if (!fileName) {
      fail(`Terminal runtime manifest entry for ${target} is missing fileName.`);
    }
    const assetPath = path.join(TERMINAL_RUNTIME_DIR, fileName);
    if (!fs.existsSync(assetPath)) {
      fail(`Terminal runtime asset missing for ${target}: ${path.relative(cwd, assetPath)}`);
    }
    runtimeFiles.push(path.relative(cwd, assetPath));
  }

  return {
    manifestFile: path.relative(cwd, manifestPath),
    runtimeFiles,
  };
}

function ensureReleaseAssets() {
  const baseAssets = ["main.js", "manifest.json", "styles.css", "studio-terminal-sidecar.cjs"];
  for (const asset of baseAssets) {
    if (!fs.existsSync(path.join(cwd, asset))) {
      fail(`Required release asset missing after build: ${asset}`);
    }
  }

  const piRuntimeAssets = collectPiRuntimeAssets();
  const runtimeAssets = collectTerminalRuntimeAssets();
  return [
    ...baseAssets,
    piRuntimeAssets.manifestFile,
    ...piRuntimeAssets.runtimeFiles,
    runtimeAssets.manifestFile,
    ...runtimeAssets.runtimeFiles,
  ];
}

function createDraftRelease(version, notesPath, releaseAssetFiles) {
  logStep(`Creating local draft GitHub release ${version}`);
  run("gh", [
    "release",
    "create",
    version,
    "--draft",
    "--verify-tag",
    "--title",
    version,
    "--notes-file",
    notesPath,
    ...releaseAssetFiles,
  ]);
}

function verifyDraftRelease(version) {
  logStep(`Verifying draft release ${version}`);
  run("gh", [
    "release",
    "view",
    version,
    "--json",
    "isDraft,assets,tagName,targetCommitish,url",
  ]);
}

function main() {
  const options = parseArgs(args);

  const repoRoot = getRepoRoot();
  if (repoRoot !== cwd) {
    fail(`Run this command from the plugin repo root. Expected: ${repoRoot}`);
  }

  ensureExpectedFiles();
  ensureCleanTree(options.allowDirty);
  ensureGitHubCliReady();

  const manifestPath = path.join(cwd, "manifest.json");
  const packagePath = path.join(cwd, "package.json");
  const lockfilePath = path.join(cwd, "package-lock.json");
  const versionsPath = path.join(cwd, "versions.json");
  const readmePath = path.join(cwd, "README.md");

  const manifest = readJson(manifestPath);
  const pkg = readJson(packagePath);
  const lockfile = readJson(lockfilePath);
  const versions = readJson(versionsPath);

  if (manifest.version !== pkg.version) {
    fail(`manifest.json (${manifest.version}) and package.json (${pkg.version}) are out of sync.`);
  }

  if (!isSemver(manifest.version)) {
    fail(`manifest.json version is not semver: ${manifest.version}`);
  }

  const lastTag = getLastTag();
  const commits = getCommitsSince(lastTag);

  if (commits.length === 0) {
    fail(lastTag
      ? `No commits found since tag ${lastTag}. Nothing to release.`
      : "No commits found in repository history. Nothing to release.");
  }

  const inferredBump = inferBump(commits);
  const bump = options.bump || inferredBump;
  const newVersion = options.version || incrementVersion(manifest.version, bump);

  if (!isSemver(newVersion)) {
    fail(`Computed invalid version: ${newVersion}`);
  }

  if (newVersion === manifest.version) {
    fail(`New version matches current version (${newVersion}).`);
  }

  ensureTagDoesNotExist(newVersion);

  printPlan({
    currentVersion: manifest.version,
    newVersion,
    bump,
    lastTag,
    commitCount: commits.length,
    dryRun: options.dryRun,
  });

  const notesPath = writeNotesFile(newVersion, commits, options.notesFile);
  logStep(`Release notes preview file: ${notesPath}`);

  if (options.dryRun) {
    logStep("Dry run complete. No files changed.");
    return;
  }

  runChecks(options.skipChecks);
  const releaseAssetFiles = ensureReleaseAssets();
  logStep(`Verified local release assets (${releaseAssetFiles.length} files).`);

  logStep(`Updating version files to ${newVersion}`);
  manifest.version = newVersion;
  pkg.version = newVersion;
  lockfile.version = newVersion;
  if (lockfile.packages && lockfile.packages[""]) {
    lockfile.packages[""].version = newVersion;
  }
  versions[newVersion] = manifest.minAppVersion;

  writeJson(manifestPath, manifest);
  writeJson(packagePath, pkg);
  writeJson(lockfilePath, lockfile);
  writeJson(versionsPath, versions);
  updateReadmeVersion(readmePath, newVersion);

  logStep("Staging release metadata files");
  run("git", ["add", "manifest.json", "package.json", "package-lock.json", "versions.json", "README.md"]);

  logStep(`Committing release metadata (release: ${newVersion})`);
  run("git", ["commit", "-m", `release: ${newVersion}`]);

  logStep(`Creating git tag ${newVersion}`);
  run("git", ["tag", "-a", newVersion, "-m", newVersion]);

  logStep("Pushing main");
  run("git", ["push", "origin", "main"]);

  logStep(`Pushing tag ${newVersion}`);
  run("git", ["push", "origin", newVersion]);

  createDraftRelease(newVersion, notesPath, releaseAssetFiles);
  verifyDraftRelease(newVersion);
  logStep(`Draft GitHub release is ready for review: ${newVersion}`);
}

main();
