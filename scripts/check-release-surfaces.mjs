#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectPluginArtifacts,
  REQUIRED_PLUGIN_ARTIFACTS,
} from "./plugin-artifacts.mjs";

export const REQUIRED_RELEASE_SOURCE_FILES = [
  "README.md",
  "LICENSE",
  "manifest.json",
  "package.json",
  "package-lock.json",
  "versions.json",
];

export const REQUIRED_VERSION_FILES = [
  "manifest.json",
  "package.json",
  "package-lock.json",
  "versions.json",
  "README.md",
];

export const REQUIRED_GITIGNORE_PATTERNS = [
  "main.js",
  "styles.css",
  "artifacts/",
  ".env",
  ".env.*",
  "config.json",
];

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJson(root, relativePath, problems) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readText(filePath));
  } catch (error) {
    problems.push(`${relativePath} is not valid JSON: ${error.message}`);
    return null;
  }
}

function hasLine(text, expectedLine) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(expectedLine);
}

function resolveNotesFile(root, version, notesFile, requireNotes) {
  if (notesFile) {
    return path.resolve(root, notesFile);
  }
  if (requireNotes) {
    return path.join(root, "docs", "release-notes", `${version}.md`);
  }
  return "";
}

export function inspectReleaseSurfaces({
  root = process.cwd(),
  version = "",
  notesFile = "",
  requireNotes = false,
  checkArtifacts = false,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const problems = [];
  const warnings = [];

  for (const relativePath of REQUIRED_RELEASE_SOURCE_FILES) {
    if (!fs.existsSync(path.join(resolvedRoot, relativePath))) {
      problems.push(`Required release source file is missing: ${relativePath}`);
    }
  }

  const manifest = readJson(resolvedRoot, "manifest.json", problems);
  const pkg = readJson(resolvedRoot, "package.json", problems);
  const lockfile = readJson(resolvedRoot, "package-lock.json", problems);
  const versions = readJson(resolvedRoot, "versions.json", problems);
  const targetVersion = version || manifest?.version || "";

  if (!SEMVER_PATTERN.test(targetVersion)) {
    problems.push(`Target version must be semver x.y.z: ${targetVersion || "(empty)"}`);
  }

  if (manifest) {
    if (manifest.version !== targetVersion) {
      problems.push(`manifest.json version is ${manifest.version}; expected ${targetVersion}`);
    }
    if (!manifest.minAppVersion) {
      problems.push("manifest.json is missing minAppVersion");
    }
  }

  if (pkg?.version !== targetVersion) {
    problems.push(`package.json version is ${pkg?.version || "(missing)"}; expected ${targetVersion}`);
  }

  if (lockfile) {
    if (lockfile.version !== targetVersion) {
      problems.push(`package-lock.json root version is ${lockfile.version || "(missing)"}; expected ${targetVersion}`);
    }
    if (lockfile.packages?.[""]?.version !== targetVersion) {
      problems.push(
        `package-lock.json packages[""].version is ${lockfile.packages?.[""]?.version || "(missing)"}; expected ${targetVersion}`
      );
    }
  }

  if (versions && manifest?.minAppVersion) {
    if (versions[targetVersion] !== manifest.minAppVersion) {
      problems.push(
        `versions.json entry for ${targetVersion} is ${versions[targetVersion] || "(missing)"}; expected ${manifest.minAppVersion}`
      );
    }
  }

  const readmePath = path.join(resolvedRoot, "README.md");
  if (fs.existsSync(readmePath)) {
    const readme = readText(readmePath);
    const pluginVersionMatch = readme.match(/- Plugin version:\s*`([^`]+)`/);
    if (!pluginVersionMatch) {
      problems.push("README.md is missing '- Plugin version: `<version>`'");
    } else if (pluginVersionMatch[1] !== targetVersion) {
      problems.push(`README.md plugin version is ${pluginVersionMatch[1]}; expected ${targetVersion}`);
    }

    const badgeVersions = [...readme.matchAll(/img\.shields\.io\/badge\/version-(\d+\.\d+\.\d+)-blue\.svg/g)]
      .map((match) => match[1]);
    for (const badgeVersion of badgeVersions) {
      if (badgeVersion !== targetVersion) {
        problems.push(`README.md version badge is ${badgeVersion}; expected ${targetVersion}`);
      }
    }

    if (manifest?.minAppVersion) {
      const minAppVersionLine = `- Minimum Obsidian version: \`${manifest.minAppVersion}\``;
      if (!hasLine(readme, minAppVersionLine)) {
        problems.push(`README.md is missing '${minAppVersionLine}'`);
      }
    }
  }

  const notesPath = resolveNotesFile(resolvedRoot, targetVersion, notesFile, requireNotes);
  if (notesPath) {
    if (!fs.existsSync(notesPath)) {
      problems.push(`Release notes file is missing: ${path.relative(resolvedRoot, notesPath)}`);
    } else {
      const notes = readText(notesPath);
      if (!notes.includes(`SystemSculpt ${targetVersion}`)) {
        problems.push(`Release notes do not mention 'SystemSculpt ${targetVersion}'`);
      }
    }
  }

  const gitignorePath = path.join(resolvedRoot, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const gitignore = readText(gitignorePath);
    for (const pattern of REQUIRED_GITIGNORE_PATTERNS) {
      if (!hasLine(gitignore, pattern)) {
        problems.push(`.gitignore is missing required release-safety pattern: ${pattern}`);
      }
    }
  } else {
    problems.push(".gitignore is missing");
  }

  if (checkArtifacts) {
    const artifactInspection = inspectPluginArtifacts({ root: resolvedRoot });
    for (const problem of artifactInspection.problems) {
      problems.push(problem);
    }
  } else {
    warnings.push(`Release artifacts not checked; pass --check-artifacts after build to verify ${REQUIRED_PLUGIN_ARTIFACTS.join(", ")}`);
  }

  return {
    ok: problems.length === 0,
    root: resolvedRoot,
    targetVersion,
    notesPath: notesPath ? path.relative(resolvedRoot, notesPath) : "",
    requiredReleaseSourceFiles: REQUIRED_RELEASE_SOURCE_FILES,
    requiredVersionFiles: REQUIRED_VERSION_FILES,
    requiredReleaseArtifacts: REQUIRED_PLUGIN_ARTIFACTS,
    problems,
    warnings,
  };
}

function parseArgs(argv) {
  const options = {
    version: "",
    notesFile: "",
    requireNotes: false,
    checkArtifacts: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      options.version = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--notes-file") {
      options.notesFile = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--require-notes") {
      options.requireNotes = true;
      continue;
    }
    if (arg === "--check-artifacts") {
      options.checkArtifacts = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHumanReport(result) {
  if (result.ok) {
    console.log(`[release-surfaces] OK for ${result.targetVersion}`);
  } else {
    console.error(`[release-surfaces] ERROR for ${result.targetVersion || "(unknown version)"}`);
    for (const problem of result.problems) {
      console.error(`[release-surfaces] - ${problem}`);
    }
  }

  for (const warning of result.warnings) {
    console.warn(`[release-surfaces] warning: ${warning}`);
  }
}

const isDirectExecution = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isDirectExecution) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = inspectReleaseSurfaces(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHumanReport(result);
    }
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(`[release-surfaces] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
