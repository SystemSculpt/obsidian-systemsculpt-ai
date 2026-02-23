#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, readlink, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APPS_DIR = `${HOME}/gits/apps`;
const REPO_DIR = `${APPS_DIR}/ml-stable-diffusion`;
const SAMPLE_BIN = `${REPO_DIR}/.build/release/StableDiffusionSample`;

const MODEL_ROOT = `${HOME}/.systemsculpt/local-image-models`;
const MODEL_ZIP_NAME =
  "coreml-stable-diffusion-2-1-base-palettized_split_einsum_v2_compiled.zip";
const MODEL_ZIP_URL =
  "https://huggingface.co/apple/coreml-stable-diffusion-2-1-base-palettized/resolve/main/coreml-stable-diffusion-2-1-base-palettized_split_einsum_v2_compiled.zip";
const EXTRACT_ROOT = `${MODEL_ROOT}/coreml-stable-diffusion-2-1-base-palettized_split_einsum_v2_compiled`;
const RESOURCE_DIR = `${EXTRACT_ROOT}/coreml-stable-diffusion-2-1-base-palettized_split_einsum_v2_compiled`;

const LOCAL_COMMAND_SOURCE = join(SCRIPT_DIR, "systemsculpt-local-imagegen");
const RATIO_BUNDLE_BUILDER = join(SCRIPT_DIR, "local-diffusion", "build-ratio-bundles.mjs");
const MODEL_MANIFEST_PATH = join(SCRIPT_DIR, "local-diffusion", "model-manifest.json");
const DEFAULT_RATIOS = "1:1,4:3,3:4,16:9,9:16";

const SYMLINK_CANDIDATES = [
  `${HOME}/bin/systemsculpt-local-imagegen`,
  "/opt/homebrew/bin/systemsculpt-local-imagegen",
];

function parseArgs(argv) {
  const options = {
    verifyOnly: false,
    ratios: DEFAULT_RATIOS,
    skipRatioBundles: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = String(argv[index] || "").trim();
    if (!token) {
      continue;
    }
    if (token === "--verify") {
      options.verifyOnly = true;
      continue;
    }
    if (token === "--ratios") {
      const value = String(argv[index + 1] || "").trim();
      index += 1;
      if (!value) {
        throw new Error("--ratios requires a comma-separated value, e.g. 1:1,16:9");
      }
      options.ratios = value;
      continue;
    }
    if (token === "--skip-ratio-bundles") {
      options.skipRatioBundles = true;
      continue;
    }
    if (token === "-h" || token === "--help") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function printUsage() {
  console.log("Usage: node scripts/install-local-macos-diffusion-backend.mjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --verify                 Verify setup only; do not clone/build/download.");
  console.log(`  --ratios <list>          Ratio list for native bundles (default: ${DEFAULT_RATIOS})`);
  console.log("  --skip-ratio-bundles     Skip ratio bundle build/verify step.");
}

async function pathExists(path, executable = false) {
  try {
    await access(path, executable ? fsConstants.X_OK : fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, cwd = process.cwd()) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

async function ensureRepo(verifyOnly) {
  await mkdir(APPS_DIR, { recursive: true });
  if (await pathExists(join(REPO_DIR, ".git"))) {
    console.log(`[install] Reusing existing repo: ${REPO_DIR}`);
    return;
  }
  if (verifyOnly) {
    throw new Error(`ml-stable-diffusion repo is missing at ${REPO_DIR}. Run installer without --verify.`);
  }
  console.log(`[install] Cloning apple/ml-stable-diffusion into ${REPO_DIR}`);
  await run("git", ["clone", "https://github.com/apple/ml-stable-diffusion.git", REPO_DIR]);
}

async function ensureSampleBinary(verifyOnly) {
  if (await pathExists(SAMPLE_BIN, true)) {
    console.log(`[install] Reusing StableDiffusionSample: ${SAMPLE_BIN}`);
    return;
  }
  if (verifyOnly) {
    throw new Error(`StableDiffusionSample binary is missing at ${SAMPLE_BIN}. Run installer without --verify.`);
  }
  console.log("[install] Building StableDiffusionSample (release)");
  await run("swift", ["build", "-c", "release", "--product", "StableDiffusionSample"], REPO_DIR);
}

async function ensureModelResources(verifyOnly) {
  await mkdir(MODEL_ROOT, { recursive: true });
  const zipPath = join(MODEL_ROOT, MODEL_ZIP_NAME);

  if (!(await pathExists(zipPath))) {
    if (verifyOnly) {
      throw new Error(`Compiled model zip is missing at ${zipPath}. Run installer without --verify.`);
    }
    console.log(`[install] Downloading model zip: ${MODEL_ZIP_NAME}`);
    await run("curl", ["-L", MODEL_ZIP_URL, "-o", zipPath], MODEL_ROOT);
  } else {
    console.log(`[install] Reusing model zip: ${zipPath}`);
  }

  if (await pathExists(RESOURCE_DIR)) {
    console.log(`[install] Reusing extracted resources: ${RESOURCE_DIR}`);
    return;
  }

  if (verifyOnly) {
    throw new Error(`Extracted model resources are missing at ${RESOURCE_DIR}. Run installer without --verify.`);
  }

  await mkdir(EXTRACT_ROOT, { recursive: true });
  console.log("[install] Extracting model resources");
  await run("unzip", ["-q", zipPath, "-d", EXTRACT_ROOT], MODEL_ROOT);

  if (!(await pathExists(RESOURCE_DIR))) {
    throw new Error(`Expected resource directory was not found after extraction: ${RESOURCE_DIR}`);
  }
}

async function ensureCommandSymlink(targetPath) {
  const dir = dirname(targetPath);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return false;
  }

  try {
    const existing = await readlink(targetPath);
    if (existing === LOCAL_COMMAND_SOURCE) {
      console.log(`[install] Symlink already configured: ${targetPath}`);
      return true;
    }
  } catch {
    // no existing symlink or unreadable path, continue
  }

  try {
    await symlink(LOCAL_COMMAND_SOURCE, targetPath);
    console.log(`[install] Created symlink: ${targetPath} -> ${LOCAL_COMMAND_SOURCE}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[install] Could not create symlink at ${targetPath}: ${message}`);
    return false;
  }
}

async function ensureCommandSymlinks(verifyOnly) {
  if (!(await pathExists(LOCAL_COMMAND_SOURCE, true))) {
    throw new Error(`Local command source is missing or not executable: ${LOCAL_COMMAND_SOURCE}`);
  }

  if (verifyOnly) {
    let discoveredPath = "";
    for (const candidate of SYMLINK_CANDIDATES) {
      if (await pathExists(candidate, true)) {
        discoveredPath = candidate;
        break;
      }
    }
    if (!discoveredPath) {
      throw new Error(
        `No systemsculpt-local-imagegen binary found in expected paths (${SYMLINK_CANDIDATES.join(", ")}). Run installer without --verify.`
      );
    }
    console.log(`[install] Verified command shim: ${discoveredPath}`);
    return;
  }

  for (const candidate of SYMLINK_CANDIDATES) {
    await ensureCommandSymlink(candidate);
  }
}

async function ensureRatioBundles(options) {
  if (!(await pathExists(RATIO_BUNDLE_BUILDER))) {
    throw new Error(`Ratio bundle helper is missing: ${RATIO_BUNDLE_BUILDER}`);
  }

  const args = [RATIO_BUNDLE_BUILDER, "--manifest", MODEL_MANIFEST_PATH, "--repo", REPO_DIR];
  const ratios = String(options.ratios || "").trim();
  if (ratios) {
    args.push("--ratios", ratios);
  }
  if (options.verifyOnly) {
    args.push("--verify");
  }

  console.log(
    `[install] ${options.verifyOnly ? "Verifying" : "Building"} native ratio bundles (${ratios || DEFAULT_RATIOS})`
  );
  await run("node", args, resolve(SCRIPT_DIR, ".."));
}

async function main() {
  const options = parseArgs(process.argv);
  console.log(
    `[install] ${options.verifyOnly ? "Verifying" : "Setting up"} local macOS diffusion backend for SystemSculpt Studio`
  );
  await ensureRepo(options.verifyOnly);
  await ensureSampleBinary(options.verifyOnly);
  await ensureModelResources(options.verifyOnly);
  await ensureCommandSymlinks(options.verifyOnly);

  if (!options.skipRatioBundles) {
    await ensureRatioBundles(options);
  } else {
    console.log("[install] Skipping native ratio bundle build/verify (--skip-ratio-bundles)");
  }

  console.log(`\n[install] ${options.verifyOnly ? "Verification" : "Setup"} completed.`);
  console.log(`[install] Sample binary: ${SAMPLE_BIN}`);
  console.log(`[install] Resource path (legacy 1:1): ${RESOURCE_DIR}`);
  console.log(`[install] Manifest path: ${MODEL_MANIFEST_PATH}`);
  console.log("[install] Optional env overrides:");
  console.log(`  export SYSTEMSCULPT_LOCAL_DIFFUSION_SAMPLE_BIN=\"${SAMPLE_BIN}\"`);
  console.log(`  export SYSTEMSCULPT_LOCAL_DIFFUSION_RESOURCE_PATH=\"${RESOURCE_DIR}\"`);
  console.log(`  export SYSTEMSCULPT_LOCAL_DIFFUSION_MANIFEST_PATH=\"${MODEL_MANIFEST_PATH}\"`);
  console.log('  export SYSTEMSCULPT_LOCAL_DIFFUSION_COMPUTE_UNITS="cpuAndNeuralEngine"');
  console.log('  export SYSTEMSCULPT_LOCAL_DIFFUSION_STEP_COUNT="20"');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[install] ${message}`);
  process.exit(1);
});
