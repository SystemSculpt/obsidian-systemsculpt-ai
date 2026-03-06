#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import {
  PI_RUNTIME_ENTRY_PACKAGE,
  collectPiRuntimePackageRoots,
} from "./pi-runtime-package-set.mjs";

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, "dist", "pi-runtime");
const MANIFEST_FILE_NAME = "studio-pi-runtime-manifest.json";
const MANIFEST_SCHEMA = "studio.pi-runtime-manifest.v1";
const SUPPORTED_TARGETS = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];

function ensureExists(absolutePath, message) {
  if (!fs.existsSync(absolutePath)) {
    throw new Error(message || `Missing required path: ${absolutePath}`);
  }
}

function copyDirectoryRecursive(sourcePath, destinationPath) {
  ensureExists(sourcePath, `Missing required directory: ${sourcePath}`);
  const stats = fs.statSync(sourcePath);
  if (!stats.isDirectory()) {
    throw new Error(`Expected directory, found file: ${sourcePath}`);
  }

  fs.mkdirSync(destinationPath, { recursive: true });
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const srcEntry = path.join(sourcePath, entry.name);
    const dstEntry = path.join(destinationPath, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcEntry, dstEntry);
    } else {
      fs.copyFileSync(srcEntry, dstEntry);
      try {
        const mode = fs.statSync(srcEntry).mode & 0o777;
        fs.chmodSync(dstEntry, mode);
      } catch {}
    }
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function buildTargetAsset(options) {
  const { entryPackageVersion, packageRoots, target } = options;
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `systemsculpt-pi-runtime-${target}-`));

  try {
    for (const packageEntry of packageRoots) {
      const destinationPath = path.join(stageRoot, packageEntry.relativePath);
      copyDirectoryRecursive(packageEntry.dir, destinationPath);
    }

    const archiveName = `studio-pi-runtime-${entryPackageVersion}-${target}.tgz`;
    const archivePath = path.join(OUTPUT_DIR, archiveName);

    await tar.c(
      {
        gzip: true,
        cwd: stageRoot,
        file: archivePath,
        portable: true,
        mtime: new Date(0),
      },
      ["node_modules"]
    );

    const archiveBytes = fs.readFileSync(archivePath);
    return {
      target,
      fileName: archiveName,
      sizeBytes: archiveBytes.byteLength,
      sha256: sha256Hex(archiveBytes),
    };
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

async function main() {
  const packageRoots = collectPiRuntimePackageRoots({ rootDir: ROOT });
  if (!packageRoots.some((entry) => entry.name === PI_RUNTIME_ENTRY_PACKAGE)) {
    throw new Error(`Pi runtime entry package ${PI_RUNTIME_ENTRY_PACKAGE} was not found in the package roots.`);
  }

  const entryPackage = packageRoots.find((entry) => entry.name === PI_RUNTIME_ENTRY_PACKAGE);
  const entryPackageVersion = String(entryPackage?.packageJson?.version || "").trim();
  if (!entryPackageVersion) {
    throw new Error(`Unable to determine version for ${PI_RUNTIME_ENTRY_PACKAGE}.`);
  }

  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const assets = {};
  for (const target of SUPPORTED_TARGETS) {
    const asset = await buildTargetAsset({ entryPackageVersion, packageRoots, target });
    assets[target] = {
      fileName: asset.fileName,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
    };
    console.log(`[pi-runtime] built ${target}: ${asset.fileName}`);
  }

  const manifest = {
    schema: MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    entryPackageName: PI_RUNTIME_ENTRY_PACKAGE,
    entryPackageVersion,
    packageRoots: packageRoots.map((entry) => entry.relativePath).sort(),
    assets,
  };

  const manifestPath = path.join(OUTPUT_DIR, MANIFEST_FILE_NAME);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[pi-runtime] wrote manifest: ${manifestPath}`);
}

main().catch((error) => {
  console.error(`[pi-runtime] failed: ${error?.message || error}`);
  process.exit(1);
});
