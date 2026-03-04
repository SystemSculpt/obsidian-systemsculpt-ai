#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

const ROOT = process.cwd();
const NODE_PTY_ROOT = path.join(ROOT, "node_modules", "node-pty");
const OUTPUT_DIR = path.join(ROOT, "dist", "terminal-runtime");
const MANIFEST_FILE_NAME = "studio-terminal-runtime-manifest.json";
const MANIFEST_SCHEMA = "studio.terminal-runtime-manifest.v1";
const SUPPORTED_TARGETS = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];

function ensureExists(absolutePath, message) {
  if (!fs.existsSync(absolutePath)) {
    throw new Error(message || `Missing required path: ${absolutePath}`);
  }
}

function copyFileSafe(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
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

function removeFilesBySuffix(rootDir, suffix) {
  if (!fs.existsSync(rootDir)) {
    return;
  }
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      removeFilesBySuffix(absolutePath, suffix);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(suffix)) {
      fs.rmSync(absolutePath, { force: true });
    }
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function buildTargetAsset(options) {
  const { nodePtyVersion, target } = options;
  const sourcePrebuildDir = path.join(NODE_PTY_ROOT, "prebuilds", target);
  ensureExists(sourcePrebuildDir, `Missing node-pty prebuild directory for ${target}: ${sourcePrebuildDir}`);

  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `systemsculpt-terminal-runtime-${target}-`));
  const stageModuleRoot = path.join(stageRoot, "node-pty");

  try {
    copyFileSafe(path.join(NODE_PTY_ROOT, "package.json"), path.join(stageModuleRoot, "package.json"));
    copyFileSafe(path.join(NODE_PTY_ROOT, "LICENSE"), path.join(stageModuleRoot, "LICENSE"));
    copyFileSafe(path.join(NODE_PTY_ROOT, "README.md"), path.join(stageModuleRoot, "README.md"));
    copyDirectoryRecursive(path.join(NODE_PTY_ROOT, "lib"), path.join(stageModuleRoot, "lib"));
    copyDirectoryRecursive(sourcePrebuildDir, path.join(stageModuleRoot, "prebuilds", target));

    removeFilesBySuffix(path.join(stageModuleRoot, "prebuilds", target), ".pdb");

    if (target.startsWith("darwin-")) {
      const helperPath = path.join(stageModuleRoot, "prebuilds", target, "spawn-helper");
      if (fs.existsSync(helperPath)) {
        fs.chmodSync(helperPath, 0o755);
      }
    }

    const archiveName = `studio-terminal-runtime-node-pty-${nodePtyVersion}-${target}.tgz`;
    const archivePath = path.join(OUTPUT_DIR, archiveName);

    await tar.c(
      {
        gzip: true,
        cwd: stageRoot,
        file: archivePath,
        portable: true,
        mtime: new Date(0),
      },
      ["node-pty"]
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
  ensureExists(NODE_PTY_ROOT, `node-pty is required at ${NODE_PTY_ROOT}. Run npm install first.`);

  const nodePtyPackageJson = JSON.parse(
    fs.readFileSync(path.join(NODE_PTY_ROOT, "package.json"), "utf8")
  );
  const nodePtyVersion = String(nodePtyPackageJson.version || "").trim();
  if (!nodePtyVersion) {
    throw new Error("Unable to determine node-pty version from package.json.");
  }

  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const assets = {};
  for (const target of SUPPORTED_TARGETS) {
    const asset = await buildTargetAsset({ nodePtyVersion, target });
    assets[target] = {
      fileName: asset.fileName,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
    };
    console.log(`[terminal-runtime] built ${target}: ${asset.fileName}`);
  }

  const manifest = {
    schema: MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    nodePtyVersion,
    assets,
  };

  const manifestPath = path.join(OUTPUT_DIR, MANIFEST_FILE_NAME);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[terminal-runtime] wrote manifest: ${manifestPath}`);
}

main().catch((error) => {
  console.error(`[terminal-runtime] failed: ${error?.message || error}`);
  process.exit(1);
});
