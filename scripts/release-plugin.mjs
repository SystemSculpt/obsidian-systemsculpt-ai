#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertProductionPluginArtifacts } from "./plugin-artifacts.mjs";
import { inspectReleaseSurfaces } from "./check-release-surfaces.mjs";

const cwd = process.cwd();
const args = process.argv.slice(2);
const GITHUB_ENV_TOKEN_KEYS = ["GITHUB_TOKEN", "GH_TOKEN"];
const GITHUB_AUTH_FALLBACK_PATTERNS = [
  /GH013/i,
  /workflow scope/i,
  /refusing to allow.*workflow/i,
  /workflows? permission/i,
  /resource not accessible by integration/i,
];

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

function buildCommandEnv(envOverrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === null || value === undefined) {
      delete env[key];
      continue;
    }
    env[key] = String(value);
  }
  return env;
}

function formatCommandLabel(command, commandArgs) {
  return `${command} ${commandArgs.join(" ")}`;
}

function combineCommandOutput(result) {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
}

function formatCommandFailure(command, commandArgs, result) {
  const details = combineCommandOutput(result);
  return `${formatCommandLabel(command, commandArgs)} failed.${details ? `\n${details}` : ""}`;
}

function run(command, commandArgs, { capture = false, allowFailure = false, envOverrides = {} } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: buildCommandEnv(envOverrides),
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
    fail(formatCommandFailure(command, commandArgs, result));
  }

  return {
    status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function runCapture(command, commandArgs, allowFailure = false, options = {}) {
  return run(command, commandArgs, { capture: true, allowFailure, ...options });
}

const REPO_SAFETY_SCAN_EXCLUDED_FILES = new Set(["scripts/release-plugin.mjs"]);

const TRACKED_LOCAL_ONLY_FILE_RULES = [
  {
    label: "tracked env file",
    test(filePath) {
      return /(^|\/)\.env(?:\.|$)/.test(filePath)
        && !/\.env(?:\.[^.\/]+)*\.(?:example|sample|template)$/i.test(filePath);
    },
  },
  {
    label: "tracked sync config",
    test(filePath) {
      return /(^|\/)systemsculpt-sync(?:\.[^.\/]+)?\.json$/i.test(filePath);
    },
  },
  {
    label: "tracked vault directory",
    test(filePath) {
      return /(^|\/)(?:\.obsidian|vault)(\/|$)/.test(filePath);
    },
  },
  {
    label: "tracked local config",
    test(filePath) {
      return /(^|\/)config\.json$/i.test(filePath);
    },
  },
  {
    label: "tracked log file",
    test(filePath) {
      return /\.log$/i.test(filePath) || /(^|\/)logs?(\/|$)/.test(filePath);
    },
  },
  {
    label: "tracked database or key material",
    test(filePath) {
      return /\.(?:db|sqlite|pem|key|p12|pfx)$/i.test(filePath);
    },
  },
];

const CONTENT_SAFETY_RULES = [
  {
    label: "absolute local filesystem path",
    pattern: /(?<![A-Za-z]:)\/Users\/[^/\s"'`]+|\/home\/[^/\s"'`]+|[A-Za-z]:\\Users\\[^\\\s"'`]+/,
  },
  {
    label: "hardcoded vault selector",
    pattern: /--vault-name\s+(?!<|\$|\$\{)[^\s"'`]+/,
  },
  {
    label: "private key material",
    pattern: /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/,
  },
  {
    label: "GitHub token",
    pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  {
    label: "OpenAI-style secret key",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/,
  },
  {
    label: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
];

function logStep(message) {
  console.log(`[release] ${message}`);
}

function fail(message) {
  console.error(`[release] ERROR: ${message}`);
  process.exit(1);
}

function withoutGitHubEnvTokens() {
  return {
    GITHUB_TOKEN: null,
    GH_TOKEN: null,
  };
}

function hasGitHubEnvTokens(env = process.env) {
  return GITHUB_ENV_TOKEN_KEYS.some((key) => Boolean(env[key]));
}

function parseGitHubAuthStatus(output) {
  const raw = String(output || "");
  const scopeLine = raw.match(/Token scopes:\s*(.+)/i)?.[1] || "";
  const scopes = scopeLine
    .split(",")
    .map((scope) => scope.replace(/['"`]/g, "").trim())
    .filter(Boolean);

  return {
    raw,
    scopes,
    usesEnvToken: /\((?:GITHUB_TOKEN|GH_TOKEN)\)/i.test(raw),
  };
}

function authHasScope(authStatus, scope) {
  return authStatus.scopes.includes(scope);
}

function shouldRetryWithoutGitHubEnv(result) {
  const output = combineCommandOutput(result);
  return GITHUB_AUTH_FALLBACK_PATTERNS.some((pattern) => pattern.test(output));
}

function writeCapturedOutput(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  }
}

function resolveGitHubReleaseAuthStrategy({
  runCaptureImpl = runCapture,
  logFn = logStep,
} = {}) {
  const auth = runCaptureImpl("gh", ["auth", "status"], true);
  const envTokensPresent = hasGitHubEnvTokens();

  if (!envTokensPresent) {
    if (auth.status !== 0) {
      const details = combineCommandOutput(auth) || "Run `gh auth login` before releasing.";
      fail(`GitHub CLI is not authenticated for release creation.\n${details}`);
    }
    return {
      name: "default",
      envOverrides: {},
    };
  }

  const tokenlessAuth = runCaptureImpl(
    "gh",
    ["auth", "status"],
    true,
    { envOverrides: withoutGitHubEnvTokens() }
  );

  if (auth.status !== 0 && tokenlessAuth.status === 0) {
    logFn("Stored gh auth is available, so push/release steps will ignore GITHUB_TOKEN/GH_TOKEN.");
    return {
      name: "stored-gh-auth",
      envOverrides: withoutGitHubEnvTokens(),
    };
  }

  const authInfo = parseGitHubAuthStatus(combineCommandOutput(auth));
  const tokenlessAuthInfo = parseGitHubAuthStatus(combineCommandOutput(tokenlessAuth));
  if (
    auth.status === 0
    && authInfo.usesEnvToken
    && !authHasScope(authInfo, "workflow")
    && tokenlessAuth.status === 0
    && authHasScope(tokenlessAuthInfo, "workflow")
  ) {
    logFn("Stored gh auth has workflow scope, so push/release steps will ignore GITHUB_TOKEN/GH_TOKEN.");
    return {
      name: "stored-gh-auth",
      envOverrides: withoutGitHubEnvTokens(),
    };
  }

  if (auth.status !== 0) {
    const details = combineCommandOutput(auth) || combineCommandOutput(tokenlessAuth) || "Run `gh auth login` before releasing.";
    fail(`GitHub CLI is not authenticated for release creation.\n${details}`);
  }

  return {
    name: "default",
    envOverrides: {},
  };
}

function runWithGitHubAuthFallback(
  command,
  commandArgs,
  {
    allowFailure = false,
    envOverrides = {},
    authStrategyName,
    name,
    runImpl = run,
    logFn = logStep,
    emitFn = writeCapturedOutput,
  } = {}
) {
  const strategyName = authStrategyName || name || "default";
  const initial = runImpl(command, commandArgs, {
    capture: true,
    allowFailure: true,
    envOverrides,
  });

  if (initial.status === 0) {
    emitFn(initial);
    return initial;
  }

  const shouldFallback =
    hasGitHubEnvTokens()
    && strategyName !== "stored-gh-auth"
    && shouldRetryWithoutGitHubEnv(initial);

  if (shouldFallback) {
    logFn(`Retrying ${formatCommandLabel(command, commandArgs)} without GITHUB_TOKEN/GH_TOKEN.`);
    const retry = runImpl(command, commandArgs, {
      capture: true,
      allowFailure: true,
      envOverrides: withoutGitHubEnvTokens(),
    });
    if (retry.status === 0) {
      emitFn(retry);
      return retry;
    }

    if (allowFailure) {
      return retry;
    }

    fail(
      `${formatCommandFailure(command, commandArgs, retry)}\n\n`
      + `Initial attempt used the inherited environment and failed with:\n${combineCommandOutput(initial)}`
    );
  }

  if (allowFailure) {
    return initial;
  }

  fail(formatCommandFailure(command, commandArgs, initial));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeRepoPath(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function listTrackedFiles() {
  const output = runCapture("git", ["ls-files", "-z"]).stdout;
  if (!output) {
    return [];
  }

  return output
    .split("\u0000")
    .map((entry) => normalizeRepoPath(entry))
    .filter(Boolean);
}

function listUntrackedNonIgnoredFiles() {
  const output = runCapture("git", ["ls-files", "--others", "--exclude-standard", "-z"]).stdout;
  if (!output) {
    return [];
  }

  return output
    .split("\u0000")
    .map((entry) => normalizeRepoPath(entry))
    .filter(Boolean);
}

function getLineNumberForIndex(content, index) {
  return content.slice(0, index).split("\n").length;
}

function truncateSample(value, maxLength = 120) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function scanTrackedFilesForLocalOnlyPaths(files) {
  const findings = [];

  for (const filePath of files) {
    for (const rule of TRACKED_LOCAL_ONLY_FILE_RULES) {
      if (rule.test(filePath)) {
        findings.push({
          filePath,
          label: rule.label,
        });
        break;
      }
    }
  }

  return findings;
}

function scanTrackedFilesForSensitiveContent(files) {
  const findings = [];

  for (const filePath of files) {
    if (REPO_SAFETY_SCAN_EXCLUDED_FILES.has(filePath)) {
      continue;
    }

    const absolutePath = path.join(cwd, filePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const buffer = fs.readFileSync(absolutePath);
    if (buffer.includes(0)) {
      continue;
    }

    const content = buffer.toString("utf8");
    for (const rule of CONTENT_SAFETY_RULES) {
      const match = rule.pattern.exec(content);
      if (!match) {
        continue;
      }

      findings.push({
        filePath,
        label: rule.label,
        line: getLineNumberForIndex(content, match.index),
        sample: truncateSample(match[0]),
      });
      break;
    }
  }

  return findings;
}

function formatRepoSafetyFindings(findings) {
  return findings
    .map((finding) => {
      const location = finding.line ? `${finding.filePath}:${finding.line}` : finding.filePath;
      return `- ${location} (${finding.label}${finding.sample ? `: ${finding.sample}` : ""})`;
    })
    .join("\n");
}

function runRepoSafetyChecks() {
  logStep("Running release safety preflight");
  const trackedFiles = listTrackedFiles();
  const untrackedNonIgnoredFiles = listUntrackedNonIgnoredFiles();
  const localOnlyFindings = scanTrackedFilesForLocalOnlyPaths(trackedFiles);
  const missingIgnoreFindings = scanTrackedFilesForLocalOnlyPaths(untrackedNonIgnoredFiles);
  const contentFindings = scanTrackedFilesForSensitiveContent(trackedFiles);

  if (localOnlyFindings.length > 0 || missingIgnoreFindings.length > 0 || contentFindings.length > 0) {
    const sections = [];
    if (localOnlyFindings.length > 0) {
      sections.push(
        "Tracked files that look local-only and should probably live in .gitignore:\n"
          + formatRepoSafetyFindings(localOnlyFindings)
      );
    }
    if (missingIgnoreFindings.length > 0) {
      sections.push(
        "Untracked local-only files are visible to git and should probably be added to .gitignore:\n"
          + formatRepoSafetyFindings(missingIgnoreFindings)
      );
    }
    if (contentFindings.length > 0) {
      sections.push(
        "Tracked text that looks private, machine-specific, or secret-like:\n"
          + formatRepoSafetyFindings(contentFindings)
      );
    }

    fail(
      "Release safety preflight failed.\n"
        + `${sections.join("\n\n")}\n\n`
        + "Remove or generalize these before creating a release commit or tag."
    );
  }

  logStep(
    "Release safety preflight passed (no tracked local-only files, missing ignore rules for local-only files, local paths, hardcoded vault selectors, or secret-looking tokens found)."
  );
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

function normalizeTagVersion(value) {
  const normalized = String(value || "").trim().replace(/^v(?=\d)/i, "");
  return isSemver(normalized) ? normalized : "";
}

function compareSemver(left, right) {
  const leftParsed = parseSemver(left);
  const rightParsed = parseSemver(right);
  for (const part of ["major", "minor", "patch"]) {
    if (leftParsed[part] !== rightParsed[part]) {
      return leftParsed[part] - rightParsed[part];
    }
  }
  return 0;
}

function isPreBumpedReleaseCandidate(currentVersion, lastTag, versions, minAppVersion) {
  const lastVersion = normalizeTagVersion(lastTag);
  return Boolean(
    lastVersion
      && isSemver(currentVersion)
      && compareSemver(currentVersion, lastVersion) > 0
      && versions?.[currentVersion] === minAppVersion
  );
}

function resolveReleaseVersionPlan({
  manifestVersion,
  lastTag,
  versions,
  minAppVersion,
  commits,
  options = {},
}) {
  const metadataAlreadyUpdated = isPreBumpedReleaseCandidate(
    manifestVersion,
    lastTag,
    versions,
    minAppVersion
  );
  const usePreBumpedMetadata = Boolean(
    metadataAlreadyUpdated
      && !options.version
      && !options.bump
  );
  const inferredBump = inferBump(commits);
  const bump = options.bump || (usePreBumpedMetadata ? "pre-bumped" : inferredBump);
  const newVersion = options.version || (usePreBumpedMetadata
    ? manifestVersion
    : incrementVersion(manifestVersion, bump));

  return {
    metadataAlreadyUpdated,
    usePreBumpedMetadata,
    inferredBump,
    bump,
    newVersion,
  };
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

function joinWrappedMarkdownLines(lines) {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function isMarkdownHeadingLine(line) {
  return /^\s{0,3}#{1,6}\s/.test(line);
}

function isMarkdownRuleLine(line) {
  return /^\s{0,3}(?:[-*_]\s*){3,}$/.test(line);
}

function isMarkdownTableLine(line) {
  return /^\s*\|/.test(line);
}

function isMarkdownBlockquoteLine(line) {
  return /^\s*>\s?/.test(line);
}

function parseMarkdownListLine(line) {
  const match = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
  if (!match) {
    return null;
  }

  return {
    indent: match[1],
    marker: match[2],
    content: match[3],
  };
}

function normalizeReleaseNotesListBlock(lines) {
  const normalizedLines = [];
  let currentItem = null;

  const flushCurrentItem = () => {
    if (!currentItem) {
      return;
    }

    normalizedLines.push(
      `${currentItem.indent}${currentItem.marker} ${joinWrappedMarkdownLines(currentItem.lines)}`
    );
    currentItem = null;
  };

  for (const line of lines) {
    const listItem = parseMarkdownListLine(line);
    if (listItem) {
      flushCurrentItem();
      currentItem = {
        indent: listItem.indent,
        marker: listItem.marker,
        lines: [listItem.content],
      };
      continue;
    }

    if (!currentItem) {
      normalizedLines.push(line.trimEnd());
      continue;
    }

    currentItem.lines.push(line);
  }

  flushCurrentItem();
  return normalizedLines;
}

function normalizeReleaseNotesBlock(lines) {
  const normalizedLines = lines.map((line) => line.trimEnd());
  if (normalizedLines.length === 0) {
    return [];
  }

  if (normalizedLines.length === 1) {
    const [line] = normalizedLines;
    if (isMarkdownHeadingLine(line) || isMarkdownRuleLine(line)) {
      return normalizedLines;
    }
  }

  if (normalizedLines.every((line) => isMarkdownTableLine(line))) {
    return normalizedLines;
  }

  if (parseMarkdownListLine(normalizedLines[0])) {
    return normalizeReleaseNotesListBlock(normalizedLines);
  }

  if (normalizedLines.every((line) => isMarkdownBlockquoteLine(line))) {
    return [`> ${joinWrappedMarkdownLines(normalizedLines.map((line) => line.replace(/^\s*>\s?/, "")))}`];
  }

  return [joinWrappedMarkdownLines(normalizedLines)];
}

function normalizeReleaseNotesMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const normalized = [];
  let block = [];
  let fenceToken = null;

  const flushBlock = () => {
    if (block.length === 0) {
      return;
    }

    normalized.push(...normalizeReleaseNotesBlock(block));
    block = [];
  };

  for (const line of lines) {
    if (fenceToken) {
      normalized.push(line);
      if (new RegExp(`^\\s*${fenceToken}{3,}`).test(line)) {
        fenceToken = null;
      }
      continue;
    }

    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      flushBlock();
      normalized.push(line);
      fenceToken = fenceMatch[1][0];
      continue;
    }

    if (!line.trim()) {
      flushBlock();
      if (normalized.length > 0 && normalized[normalized.length - 1] !== "") {
        normalized.push("");
      }
      continue;
    }

    block.push(line);
  }

  flushBlock();

  while (normalized[0] === "") {
    normalized.shift();
  }
  while (normalized[normalized.length - 1] === "") {
    normalized.pop();
  }

  return normalized.join("\n");
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

function toRepoRelativePath(filePath, root = cwd) {
  return path.relative(root, path.resolve(root, filePath)).split(path.sep).join("/");
}

function expectedReleaseNotesPath(version) {
  return `docs/release-notes/${version}.md`;
}

function validateAuthoredReleaseNotesFile({
  notesFile,
  dryRun = false,
  version,
  root = cwd,
} = {}) {
  const expectedPath = expectedReleaseNotesPath(version);
  if (!notesFile) {
    return {
      ok: Boolean(dryRun),
      expectedPath,
      relativePath: "",
      problem: dryRun
        ? ""
        : `Real releases require authored public notes: --notes-file ${expectedPath}`,
    };
  }

  const relativePath = toRepoRelativePath(notesFile, root);
  if (dryRun) {
    return {
      ok: true,
      expectedPath,
      relativePath,
      problem: "",
    };
  }

  if (relativePath !== expectedPath) {
    return {
      ok: false,
      expectedPath,
      relativePath,
      problem: `Release notes file must be ${expectedPath}; got ${relativePath}`,
    };
  }

  return {
    ok: true,
    expectedPath,
    relativePath,
    problem: "",
  };
}

function ensureAuthoredReleaseNotesFile(options, version) {
  const validation = validateAuthoredReleaseNotesFile({
    notesFile: options.notesFile,
    dryRun: options.dryRun,
    version,
  });

  if (!validation.ok) {
    fail(validation.problem);
  }

  return validation;
}

function ensureGitHubCliReady() {
  return resolveGitHubReleaseAuthStrategy();
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
  githubAuthStrategyName,
}) {
  console.log("\n[release] Plan");
  console.log(`[release] - Current version: ${currentVersion}`);
  console.log(`[release] - Next version: ${newVersion} (${bump})`);
  console.log(`[release] - Last tag: ${lastTag || "(none)"}`);
  console.log(`[release] - Commits included: ${commitCount}`);
  console.log("[release] - Local GitHub draft release via gh: yes");
  console.log(`[release] - GitHub auth mode: ${githubAuthStrategyName}`);
  console.log("[release] - Native validation: required macOS + Windows + Android; iOS when available");
  console.log(`[release] - Dry run: ${dryRun ? "yes" : "no"}`);
}

function writeNotesFile(version, commits, customNotesFile) {
  let notes;
  if (customNotesFile) {
    const resolvedNotesPath = path.resolve(cwd, customNotesFile);
    if (!fs.existsSync(resolvedNotesPath)) {
      fail(`Notes file does not exist: ${resolvedNotesPath}`);
    }
    notes = fs.readFileSync(resolvedNotesPath, "utf8");
  } else {
    notes = buildReleaseNotes(version, commits);
  }

  const normalizedNotes = normalizeReleaseNotesMarkdown(notes);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-release-"));
  const notesPath = path.join(tempDir, `${version}.md`);
  fs.writeFileSync(notesPath, `${normalizedNotes}\n`, "utf8");
  return notesPath;
}

function runChecks(skipChecks) {
  if (skipChecks) {
    logStep("Skipping checks (--skip-checks).");
    return;
  }

  logStep("Running npm run check:plugin");
  run("npm", ["run", "check:plugin"]);

  logStep("Running npm test");
  run("npm", ["test"]);

  logStep("Running npm run build");
  run("npm", ["run", "build"]);

  logStep("Running npm run check:release:native");
  run("npm", ["run", "check:release:native"]);
}

function ensureReleaseAssets() {
  const baseAssets = ["main.js", "manifest.json", "styles.css"];
  for (const asset of baseAssets) {
    if (!fs.existsSync(path.join(cwd, asset))) {
      fail(`Required release asset missing after build: ${asset}`);
    }
  }

  try {
    assertProductionPluginArtifacts({ root: cwd });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  return baseAssets;
}

function createDraftRelease(version, notesPath, releaseAssetFiles, githubAuthStrategy) {
  logStep(`Creating local draft GitHub release ${version}`);
  runWithGitHubAuthFallback("gh", [
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
  ], githubAuthStrategy);
}

function verifyDraftRelease(version, githubAuthStrategy) {
  logStep(`Verifying draft release ${version}`);
  runWithGitHubAuthFallback("gh", [
    "release",
    "view",
    version,
    "--json",
    "isDraft,assets,tagName,targetCommitish,url",
  ], githubAuthStrategy);
}

function main() {
  const options = parseArgs(args);

  const repoRoot = getRepoRoot();
  if (repoRoot !== cwd) {
    fail(`Run this command from the plugin repo root. Expected: ${repoRoot}`);
  }

  ensureExpectedFiles();
  ensureCleanTree(options.allowDirty);
  const githubAuthStrategy = ensureGitHubCliReady();
  runRepoSafetyChecks();

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

  const {
    usePreBumpedMetadata,
    bump,
    newVersion,
  } = resolveReleaseVersionPlan({
    manifestVersion: manifest.version,
    lastTag,
    versions,
    minAppVersion: manifest.minAppVersion,
    commits,
    options,
  });

  if (!isSemver(newVersion)) {
    fail(`Computed invalid version: ${newVersion}`);
  }

  if (newVersion === manifest.version && !usePreBumpedMetadata) {
    fail(`New version matches current version (${newVersion}).`);
  }

  if (usePreBumpedMetadata) {
    logStep(`Using pre-bumped release metadata for ${newVersion}.`);
  }

  ensureTagDoesNotExist(newVersion);

  printPlan({
    currentVersion: manifest.version,
    newVersion,
    bump,
    lastTag,
    commitCount: commits.length,
    dryRun: options.dryRun,
    githubAuthStrategyName: githubAuthStrategy.name,
  });

  ensureAuthoredReleaseNotesFile(options, newVersion);
  const notesPath = writeNotesFile(newVersion, commits, options.notesFile);
  logStep(`Release notes preview file: ${notesPath}`);

  if (options.dryRun) {
    logStep("Dry run complete. No files changed.");
    return;
  }

  runChecks(options.skipChecks);
  const releaseAssetFiles = ensureReleaseAssets();
  logStep(`Verified local release assets (${releaseAssetFiles.length} files).`);

  if (usePreBumpedMetadata) {
    logStep(`Version files already point at ${newVersion}; skipping metadata rewrite and release commit.`);
  } else {
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
  }

  const releaseSurfaceCheck = inspectReleaseSurfaces({
    root: cwd,
    version: newVersion,
    notesFile: options.notesFile,
    requireNotes: true,
    checkArtifacts: true,
  });
  if (!releaseSurfaceCheck.ok) {
    fail(`Release surface check failed:\n${releaseSurfaceCheck.problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
  logStep("Release surfaces verified.");

  if (!usePreBumpedMetadata) {
    logStep("Staging release metadata files");
    run("git", ["add", "manifest.json", "package.json", "package-lock.json", "versions.json", "README.md"]);

    logStep(`Committing release metadata (release: ${newVersion})`);
    run("git", ["commit", "-m", `release: ${newVersion}`]);
  }

  logStep(`Creating git tag ${newVersion}`);
  run("git", ["tag", "-a", newVersion, "-m", newVersion]);

  logStep("Pushing main");
  runWithGitHubAuthFallback("git", ["push", "origin", "main"], githubAuthStrategy);

  logStep(`Pushing tag ${newVersion}`);
  runWithGitHubAuthFallback("git", ["push", "origin", newVersion], githubAuthStrategy);

  createDraftRelease(newVersion, notesPath, releaseAssetFiles, githubAuthStrategy);
  verifyDraftRelease(newVersion, githubAuthStrategy);
  logStep(`Draft GitHub release is ready for review: ${newVersion}`);
}

const isDirectExecution = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isDirectExecution) {
  main();
}

export {
  hasGitHubEnvTokens,
  normalizeReleaseNotesMarkdown,
  parseGitHubAuthStatus,
  resolveGitHubReleaseAuthStrategy,
  resolveReleaseVersionPlan,
  validateAuthoredReleaseNotesFile,
  runWithGitHubAuthFallback,
  shouldRetryWithoutGitHubEnv,
  withoutGitHubEnvTokens,
  writeNotesFile,
};
