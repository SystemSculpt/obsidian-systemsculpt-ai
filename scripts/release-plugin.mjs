#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertProductionPluginArtifacts,
  buildProductionPlugin,
  REQUIRED_PLUGIN_ARTIFACTS,
} from "./plugin-artifacts.mjs";

const SEMVER = /^\d+\.\d+\.\d+$/;

function readJson(root, fileName) {
  return JSON.parse(fs.readFileSync(path.join(root, fileName), "utf8"));
}

export function validateReleasePackage({
  root = process.cwd(),
  build = true,
  buildImpl = buildProductionPlugin,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const manifest = readJson(resolvedRoot, "manifest.json");
  const pkg = readJson(resolvedRoot, "package.json");
  const lock = readJson(resolvedRoot, "package-lock.json");
  const versions = readJson(resolvedRoot, "versions.json");
  const version = manifest.version;
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
  if (problems.length > 0) throw new Error(problems.join("\n"));

  const artifacts = build
    ? buildImpl({ root: resolvedRoot, stdio: "inherit" })
    : assertProductionPluginArtifacts({ root: resolvedRoot });

  return { root: resolvedRoot, version, files: [...REQUIRED_PLUGIN_ARTIFACTS], artifacts };
}

const direct = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (direct) {
  try {
    const unknown = process.argv.slice(2).filter((arg) => arg !== "--no-build");
    if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
    const result = validateReleasePackage({ build: !process.argv.includes("--no-build") });
    console.log(`[release] OK ${result.version}: ${result.files.join(", ")}`);
  } catch (error) {
    console.error(`[release] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
