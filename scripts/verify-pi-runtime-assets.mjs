#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as tar from "tar";

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, "dist", "pi-runtime");
const MANIFEST_PATH = path.join(OUTPUT_DIR, "studio-pi-runtime-manifest.json");

function fail(message) {
  console.error(`[pi-runtime-verify] ${message}`);
  process.exit(1);
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    fail(`Missing manifest: ${MANIFEST_PATH}`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function resolveTargets(args, manifest) {
  const explicit = args.find((arg) => arg.startsWith("--target="));
  if (explicit) {
    const value = explicit.slice("--target=".length).trim();
    if (value.toLowerCase() === "all") {
      return Object.keys(manifest?.assets || {}).sort();
    }
    return [value];
  }

  const currentTarget = `${process.platform}-${process.arch}`;
  if (manifest?.assets?.[currentTarget]) {
    return [currentTarget];
  }
  return Object.keys(manifest?.assets || {}).sort();
}

async function verifyTarget(manifest, target) {
  const asset = manifest?.assets?.[target];
  if (!asset?.fileName) {
    fail(`No Pi runtime archive listed for target ${target}.`);
  }

  const archivePath = path.join(OUTPUT_DIR, asset.fileName);
  if (!fs.existsSync(archivePath)) {
    fail(`Missing Pi runtime archive: ${archivePath}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `systemsculpt-pi-runtime-${target}-`));
  try {
    await tar.x({
      cwd: tempRoot,
      file: archivePath,
    });

    const entryPath = path.join(tempRoot, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "index.js");
    if (!fs.existsSync(entryPath)) {
      fail(`Extracted Pi runtime is missing entry point: ${entryPath}`);
    }

    const sdk = await import(pathToFileURL(entryPath).href);
    if (!sdk?.AuthStorage || typeof sdk.AuthStorage.create !== "function") {
      fail("Extracted Pi runtime does not expose AuthStorage.create().");
    }
    if (typeof sdk.ModelRegistry !== "function") {
      fail("Extracted Pi runtime does not expose ModelRegistry.");
    }

    const storage = sdk.AuthStorage.create();
    const providers = storage.getOAuthProviders();
    if (!Array.isArray(providers) || providers.length === 0) {
      fail("Extracted Pi runtime did not return any OAuth providers.");
    }

    console.log(`[pi-runtime-verify] verified ${target}: ${asset.fileName} (${providers.length} OAuth providers available)`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const manifest = readManifest();
  const targets = resolveTargets(process.argv.slice(2), manifest);
  if (!Array.isArray(targets) || targets.length === 0) {
    fail("No Pi runtime archives were found in the manifest.");
  }

  for (const target of targets) {
    await verifyTarget(manifest, target);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack || error.message : String(error));
});
