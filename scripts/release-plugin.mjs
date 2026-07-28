#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  buildProductionPlugin,
  REQUIRED_PLUGIN_ARTIFACTS,
} from "./plugin-artifacts.mjs";
import {
  createRepositoryScopedGitEnvironment,
  DEFAULT_CI_EVIDENCE_DIRECTORY,
  writeBuildProvenance,
} from "./build-provenance.mjs";

const SEMVER = /^\d+\.\d+\.\d+$/;
const FULL_GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function readJson(root, fileName) {
  return JSON.parse(fs.readFileSync(path.join(root, fileName), "utf8"));
}

export function resolveReleaseTagRevision({
  root,
  tag,
  spawnSyncImpl = spawnSync,
  environment = process.env,
}) {
  const result = spawnSyncImpl(
    "git",
    ["-C", path.resolve(root), "rev-parse", "--verify", `refs/tags/${tag}^{commit}`],
    {
      encoding: "utf8",
      env: createRepositoryScopedGitEnvironment(environment),
      stdio: "pipe",
    },
  );
  if (result?.error || result?.status !== 0) return null;
  const revision = String(result.stdout || "").trim();
  return FULL_GIT_REVISION.test(revision) ? revision : null;
}

export function validateReleasePackage({
  root = process.cwd(),
  buildImpl = buildProductionPlugin,
  provenanceImpl = writeBuildProvenance,
  resolveTagRevisionImpl = resolveReleaseTagRevision,
  expectedRevision,
  expectedTag,
  requireClean = true,
  requireTag = true,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const manifest = readJson(resolvedRoot, "manifest.json");
  const pkg = readJson(resolvedRoot, "package.json");
  const lock = readJson(resolvedRoot, "package-lock.json");
  const versions = readJson(resolvedRoot, "versions.json");
  const version = manifest.version;
  const releaseTag = expectedTag ?? version;
  const problems = [];

  if (!SEMVER.test(version || "")) problems.push("manifest.json version must be semantic x.y.z");
  if (pkg.version !== version) problems.push("package.json version does not match manifest.json");
  if (lock.version !== version) problems.push("package-lock.json version does not match manifest.json");
  if (lock.packages?.[""]?.version !== version) {
    problems.push('package-lock.json packages[""].version does not match manifest.json');
  }
  if (!manifest.minAppVersion || versions[version] !== manifest.minAppVersion) {
    problems.push("versions.json does not map the release to manifest.json minAppVersion");
  }
  if (releaseTag !== version) {
    problems.push(`release tag ${releaseTag} does not match manifest.json version ${version}`);
  }
  if (expectedRevision !== undefined && !FULL_GIT_REVISION.test(expectedRevision)) {
    problems.push("expected release revision must be a full lowercase Git revision");
  }
  const tagRevision = requireTag && problems.length === 0
    ? resolveTagRevisionImpl({ root: resolvedRoot, tag: releaseTag })
    : null;
  if (requireTag && !FULL_GIT_REVISION.test(tagRevision || "")) {
    problems.push(`release tag ${releaseTag} must resolve to one full Git revision`);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));

  const artifacts = buildImpl({ root: resolvedRoot, stdio: "inherit" });
  const provenance = provenanceImpl({
    root: resolvedRoot,
    version,
    kind: "release",
    outputPath: path.join(
      resolvedRoot,
      DEFAULT_CI_EVIDENCE_DIRECTORY,
      `release-provenance-${version}.json`,
    ),
  });
  const releaseRevision = provenance?.record?.git?.revision;
  const releaseDirty = provenance?.record?.git?.dirty;
  if (expectedRevision !== undefined && releaseRevision !== expectedRevision) {
    throw new Error(
      `release provenance revision ${releaseRevision || "unknown"} does not match expected ${expectedRevision}`,
    );
  }
  if (requireTag && releaseRevision !== tagRevision) {
    throw new Error(
      `release provenance revision ${releaseRevision || "unknown"} does not match tag ${releaseTag} at ${tagRevision}`,
    );
  }
  if (requireClean && !FULL_GIT_REVISION.test(releaseRevision || "")) {
    throw new Error("release provenance must record a full Git revision");
  }
  if (requireClean && releaseDirty !== false) {
    throw new Error("release provenance must come from a clean Git worktree");
  }
  for (const fileName of REQUIRED_PLUGIN_ARTIFACTS) {
    const artifact = provenance?.record?.artifacts?.[fileName];
    if (
      artifact?.exists !== true
      || !Number.isInteger(artifact.sizeBytes)
      || artifact.sizeBytes <= 0
      || !/^[a-f0-9]{64}$/.test(artifact.sha256 || "")
    ) {
      throw new Error(`release provenance is incomplete for ${fileName}`);
    }
  }

  return {
    root: resolvedRoot,
    version,
    files: [...REQUIRED_PLUGIN_ARTIFACTS],
    artifacts,
    provenance,
  };
}

export function parseReleaseArguments(args = []) {
  const options = {
    requireClean: true,
    requireTag: true,
    expectedRevision: undefined,
    expectedTag: undefined,
  };
  for (const arg of args) {
    if (arg === "--require-clean") {
      options.requireClean = true;
    } else if (arg === "--require-tag") {
      options.requireTag = true;
    } else if (arg.startsWith("--expected-revision=")) {
      options.expectedRevision = arg.slice("--expected-revision=".length);
    } else if (arg.startsWith("--expected-tag=")) {
      options.expectedTag = arg.slice("--expected-tag=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

const direct = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (direct) {
  try {
    const result = validateReleasePackage(parseReleaseArguments(process.argv.slice(2)));
    console.log(`[release] OK ${result.version}: ${result.files.join(", ")}`);
    console.log(`[release] Provenance: ${result.provenance.path}`);
  } catch (error) {
    console.error(`[release] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
