#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readlink, symlink } from "node:fs/promises";

const HOME = homedir();
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

const LOCAL_COMMAND_SOURCE = `${HOME}/gits/obsidian-systemsculpt-ai/scripts/systemsculpt-local-imagegen`;
const SYMLINK_CANDIDATES = [`${HOME}/bin/systemsculpt-local-imagegen`, "/opt/homebrew/bin/systemsculpt-local-imagegen"];

async function pathExists(path, executable = false) {
  try {
    await access(path, executable ? fsConstants.X_OK : fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, cwd = process.cwd()) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

async function ensureRepo() {
  await mkdir(APPS_DIR, { recursive: true });
  if (await pathExists(join(REPO_DIR, ".git"))) {
    console.log(`[install] Reusing existing repo: ${REPO_DIR}`);
    return;
  }
  console.log(`[install] Cloning apple/ml-stable-diffusion into ${REPO_DIR}`);
  await run("git", ["clone", "https://github.com/apple/ml-stable-diffusion.git", REPO_DIR]);
}

async function ensureSampleBinary() {
  if (await pathExists(SAMPLE_BIN, true)) {
    console.log(`[install] Reusing StableDiffusionSample: ${SAMPLE_BIN}`);
    return;
  }
  console.log("[install] Building StableDiffusionSample (release)");
  await run("swift", ["build", "-c", "release", "--product", "StableDiffusionSample"], REPO_DIR);
}

async function ensureModelResources() {
  await mkdir(MODEL_ROOT, { recursive: true });
  const zipPath = join(MODEL_ROOT, MODEL_ZIP_NAME);

  if (!(await pathExists(zipPath))) {
    console.log(`[install] Downloading model zip: ${MODEL_ZIP_NAME}`);
    await run("curl", ["-L", MODEL_ZIP_URL, "-o", zipPath], MODEL_ROOT);
  } else {
    console.log(`[install] Reusing model zip: ${zipPath}`);
  }

  if (await pathExists(RESOURCE_DIR)) {
    console.log(`[install] Reusing extracted resources: ${RESOURCE_DIR}`);
    return;
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

async function ensureCommandSymlinks() {
  if (!(await pathExists(LOCAL_COMMAND_SOURCE, true))) {
    throw new Error(`Local command source is missing or not executable: ${LOCAL_COMMAND_SOURCE}`);
  }
  for (const candidate of SYMLINK_CANDIDATES) {
    await ensureCommandSymlink(candidate);
  }
}

async function main() {
  console.log("[install] Setting up local macOS diffusion backend for SystemSculpt Studio");
  await ensureRepo();
  await ensureSampleBinary();
  await ensureModelResources();
  await ensureCommandSymlinks();

  console.log("\n[install] Completed.");
  console.log(`[install] Sample binary: ${SAMPLE_BIN}`);
  console.log(`[install] Resource path: ${RESOURCE_DIR}`);
  console.log("[install] Optional env overrides:");
  console.log(`  export SYSTEMSCULPT_LOCAL_DIFFUSION_SAMPLE_BIN="${SAMPLE_BIN}"`);
  console.log(`  export SYSTEMSCULPT_LOCAL_DIFFUSION_RESOURCE_PATH="${RESOURCE_DIR}"`);
  console.log('  export SYSTEMSCULPT_LOCAL_DIFFUSION_COMPUTE_UNITS="cpuAndNeuralEngine"');
  console.log('  export SYSTEMSCULPT_LOCAL_DIFFUSION_STEP_COUNT="20"');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[install] ${message}`);
  process.exit(1);
});
