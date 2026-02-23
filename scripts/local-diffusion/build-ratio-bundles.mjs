#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH_DEFAULT = join(SCRIPT_DIR, "model-manifest.json");
const PYTHON_VENV_DIR_DEFAULT = `${HOME}/.systemsculpt/local-image-models/.venv-ml-stable-diffusion`;
const PYTHON_BIN_DEFAULT = `${PYTHON_VENV_DIR_DEFAULT}/bin/python3`;
const BOOTSTRAP_PYTHON_BIN_DEFAULT = "python3";
const TARGET_VENV_PYTHON_VERSION = "3.11";
const REQUIRED_RESOURCE_FILES = [
  "TextEncoder.mlmodelc",
  "Unet.mlmodelc",
  "VAEDecoder.mlmodelc",
  "VAEEncoder.mlmodelc",
  "vocab.json",
  "merges.txt",
];
const DEFAULT_MODEL_VERSION = "stabilityai/stable-diffusion-2-1-base";
const MAX_RELIABLE_PYTHON_MINOR = 11;

function parseArgs(argv) {
  const options = {
    ratios: [],
    verifyOnly: false,
    skipExisting: true,
    pythonBin: process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_PYTHON_BIN || PYTHON_BIN_DEFAULT,
    bootstrapPythonBin:
      process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_BOOTSTRAP_PYTHON_BIN ||
      BOOTSTRAP_PYTHON_BIN_DEFAULT,
    repoPath:
      process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_REPO ||
      `${HOME}/gits/apps/ml-stable-diffusion`,
    manifestPath:
      process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_MANIFEST_PATH || MANIFEST_PATH_DEFAULT,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = String(argv[index] || "").trim();
    if (!token) continue;
    if (token === "--verify") {
      options.verifyOnly = true;
      continue;
    }
    if (token === "--no-skip-existing") {
      options.skipExisting = false;
      continue;
    }
    if (token === "--ratios") {
      const value = String(argv[index + 1] || "").trim();
      index += 1;
      if (!value) {
        throw new Error("--ratios requires a comma-separated value, e.g. 1:1,16:9");
      }
      options.ratios = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      continue;
    }
    if (token === "--python") {
      const value = String(argv[index + 1] || "").trim();
      index += 1;
      if (!value) throw new Error("--python requires a value.");
      options.pythonBin = value;
      continue;
    }
    if (token === "--bootstrap-python") {
      const value = String(argv[index + 1] || "").trim();
      index += 1;
      if (!value) throw new Error("--bootstrap-python requires a value.");
      options.bootstrapPythonBin = value;
      continue;
    }
    if (token === "--repo") {
      const value = String(argv[index + 1] || "").trim();
      index += 1;
      if (!value) throw new Error("--repo requires a value.");
      options.repoPath = value;
      continue;
    }
    if (token === "--manifest") {
      const value = String(argv[index + 1] || "").trim();
      index += 1;
      if (!value) throw new Error("--manifest requires a value.");
      options.manifestPath = value;
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
  console.log("Usage: node scripts/local-diffusion/build-ratio-bundles.mjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --ratios 1:1,16:9       Build/verify only selected ratios (default: all)");
  console.log("  --verify                Verify resources exist; do not convert/build");
  console.log(`  --python <bin>          Python binary (default: ${PYTHON_BIN_DEFAULT})`);
  console.log("  --bootstrap-python <bin>  Python used to create venv when missing");
  console.log("  --repo <path>           ml-stable-diffusion repo path");
  console.log("  --manifest <path>       Model manifest path");
  console.log("  --no-skip-existing      Rebuild even when target resources already exist");
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

function substituteHome(value) {
  return String(value || "").replaceAll("${HOME}", HOME);
}

async function loadManifest(manifestPath) {
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Manifest at ${manifestPath} is not a JSON object.`);
  }
  if (parsed.schema !== "studio.local-diffusion.model-manifest.v1") {
    throw new Error(`Manifest schema mismatch in ${manifestPath}: ${String(parsed.schema || "<missing>")}`);
  }
  if (!parsed.ratios || typeof parsed.ratios !== "object") {
    throw new Error(`Manifest at ${manifestPath} is missing "ratios".`);
  }
  return parsed;
}

async function assertResourceDir(resourcePath) {
  for (const required of REQUIRED_RESOURCE_FILES) {
    const exists = await pathExists(join(resourcePath, required));
    if (!exists) {
      throw new Error(`Missing ${required} under ${resourcePath}`);
    }
  }
}

async function ensurePythonConversionDeps(pythonBin, repoPath, bootstrapPythonBin) {
  const detectedVersion = readPythonVersion(pythonBin);
  if (detectedVersion) {
    console.log(
      `[build-ratios] Python candidate: ${pythonBin} (${detectedVersion.major}.${detectedVersion.minor})`
    );
  } else {
    console.log(`[build-ratios] Python candidate: ${pythonBin} (version unknown)`);
  }

  const usesPathLikeBinary = pythonBin.includes("/");
  if (usesPathLikeBinary) {
    const venvDir = dirname(dirname(pythonBin));
    const existingVersion = detectedVersion;
    const isTooNew =
      Boolean(existingVersion) &&
      existingVersion.major === 3 &&
      existingVersion.minor > MAX_RELIABLE_PYTHON_MINOR;
    const needsFreshVenv =
      !(await pathExists(pythonBin, true)) ||
      isTooNew;

    if (needsFreshVenv) {
      if (isTooNew && existingVersion) {
        console.log(
          `[build-ratios] Existing venv Python ${existingVersion.major}.${existingVersion.minor} is too new for this converter toolchain. Recreating with Python ${TARGET_VENV_PYTHON_VERSION}.`
        );
      }
      await createManagedVenv(venvDir, bootstrapPythonBin, repoPath);
    }
  } else {
    const currentVersion = readPythonVersion(pythonBin);
    if (currentVersion && currentVersion.major === 3 && currentVersion.minor > MAX_RELIABLE_PYTHON_MINOR) {
      throw new Error(
        `Python binary "${pythonBin}" is version ${currentVersion.major}.${currentVersion.minor}, which is too new for required converter dependencies. Use --python with a ${TARGET_VENV_PYTHON_VERSION} venv path or allow default managed venv.`
      );
    }
  }

  try {
    await run(
      pythonBin,
      [
        "-c",
        "import torch, coremltools, diffusers, transformers, python_coreml_stable_diffusion",
      ],
      repoPath
    );
    return pythonBin;
  } catch {
    console.log("[build-ratios] Missing Python conversion dependencies. Installing requirements + editable package...");
    await ensurePipAvailable(pythonBin, repoPath);
    await run(pythonBin, ["-m", "pip", "install", "--upgrade", "pip"], repoPath);
    await run(pythonBin, ["-m", "pip", "install", "-r", "requirements.txt"], repoPath);
    await run(pythonBin, ["-m", "pip", "install", "-e", "."], repoPath);
    await run(
      pythonBin,
      [
        "-c",
        "import torch, coremltools, diffusers, transformers, python_coreml_stable_diffusion",
      ],
      repoPath
    );
    return pythonBin;
  }
}

function readPythonVersion(pythonBin) {
  try {
    const raw = execFileSync(
      pythonBin,
      ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const match = String(raw || "")
      .trim()
      .match(/^(\d+)\.(\d+)$/);
    if (!match) {
      return null;
    }
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
    };
  } catch {
    return null;
  }
}

async function createManagedVenv(venvDir, bootstrapPythonBin, repoPath) {
  await rm(venvDir, { recursive: true, force: true });
  await mkdir(dirname(venvDir), { recursive: true });
  try {
    console.log(`[build-ratios] Creating Python venv with uv at ${venvDir}`);
    await run("uv", ["venv", "--seed", "--python", TARGET_VENV_PYTHON_VERSION, venvDir], repoPath);
    return;
  } catch {
    console.log(
      `[build-ratios] uv venv bootstrap unavailable. Falling back to ${bootstrapPythonBin} -m venv.`
    );
    await run(bootstrapPythonBin, ["-m", "venv", venvDir], repoPath);
  }
}

async function ensurePipAvailable(pythonBin, repoPath) {
  try {
    await run(pythonBin, ["-m", "pip", "--version"], repoPath);
    return;
  } catch {
    console.log(`[build-ratios] Bootstrapping pip via ensurepip for ${pythonBin}`);
    await run(pythonBin, ["-m", "ensurepip", "--upgrade"], repoPath);
  }
}

async function convertRatio(options) {
  const {
    pythonBin,
    repoPath,
    modelVersion,
    ratio,
    spec,
    targetResourcesPath,
  } = options;

  const outputDir = dirname(targetResourcesPath);
  await mkdir(outputDir, { recursive: true });

  const latentHeight = Number(spec.latentHeight);
  const latentWidth = Number(spec.latentWidth);
  const attentionImplementation =
    String(spec.attentionImplementation || process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_ATTENTION_IMPL || "")
      .trim()
      .toUpperCase() || "ORIGINAL";
  const quantizeNBits = String(spec.quantizeNBits || process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_QUANTIZE_NBITS || "")
    .trim() || "6";
  if (!Number.isFinite(latentHeight) || !Number.isFinite(latentWidth)) {
    throw new Error(`Ratio ${ratio} is missing valid latent sizes in manifest.`);
  }

  console.log(`[build-ratios] Converting ratio ${ratio} to ${targetResourcesPath}`);
  await run(
    pythonBin,
    [
      "-m",
      "python_coreml_stable_diffusion.torch2coreml",
      "--model-version",
      modelVersion,
      "--convert-text-encoder",
      "--convert-unet",
      "--convert-vae-decoder",
      "--convert-vae-encoder",
      "--bundle-resources-for-swift-cli",
      "--attention-implementation",
      attentionImplementation,
      "--quantize-nbits",
      quantizeNBits,
      "--latent-h",
      String(latentHeight),
      "--latent-w",
      String(latentWidth),
      "-o",
      outputDir,
    ],
    repoPath
  );

  await assertResourceDir(targetResourcesPath);
}

async function main() {
  const args = parseArgs(process.argv);
  const manifestPath = resolve(args.manifestPath);
  const repoPath = resolve(args.repoPath);
  const pythonBin = args.pythonBin.includes("/") ? resolve(args.pythonBin) : args.pythonBin;
  const bootstrapPythonBin = args.bootstrapPythonBin.includes("/")
    ? resolve(args.bootstrapPythonBin)
    : args.bootstrapPythonBin;

  if (!(await pathExists(join(repoPath, ".git")))) {
    throw new Error(`ml-stable-diffusion repo not found at ${repoPath}.`);
  }

  const manifest = await loadManifest(manifestPath);
  const ratios = Object.keys(manifest.ratios);
  const selectedRatios = args.ratios.length > 0 ? args.ratios : ratios;

  for (const ratio of selectedRatios) {
    if (!manifest.ratios[ratio]) {
      throw new Error(`Ratio ${ratio} not found in manifest ${manifestPath}.`);
    }
  }

  const modelVersion = String(manifest.profileModelVersion || DEFAULT_MODEL_VERSION).trim() || DEFAULT_MODEL_VERSION;
  console.log(`[build-ratios] Using manifest: ${manifestPath}`);
  console.log(`[build-ratios] Ratios: ${selectedRatios.join(", ")}`);

  let activePythonBin = pythonBin;
  if (!args.verifyOnly) {
    activePythonBin = await ensurePythonConversionDeps(
      pythonBin,
      repoPath,
      bootstrapPythonBin
    );
  }

  for (const ratio of selectedRatios) {
    const spec = manifest.ratios[ratio];
    const targetResourcesPath = resolve(substituteHome(spec.resourcePath));

    const exists = await pathExists(targetResourcesPath);
    if (exists) {
      try {
        await assertResourceDir(targetResourcesPath);
        console.log(`[build-ratios] OK ${ratio}: ${targetResourcesPath}`);
        if (args.verifyOnly || args.skipExisting) {
          continue;
        }
      } catch (error) {
        console.log(`[build-ratios] Rebuilding ${ratio}; existing resource dir is incomplete.`);
      }
    } else if (args.verifyOnly) {
      throw new Error(`Missing ratio resources for ${ratio}: ${targetResourcesPath}`);
    }

    if (ratio === "1:1") {
      // 1:1 is expected to come from the pre-downloaded compiled bundle path.
      throw new Error(
        `Ratio ${ratio} resources are missing at ${targetResourcesPath}. Run node scripts/install-local-macos-diffusion-backend.mjs first.`
      );
    }

    if (args.verifyOnly) {
      continue;
    }

    await convertRatio({
      pythonBin: activePythonBin,
      repoPath,
      modelVersion,
      ratio,
      spec,
      targetResourcesPath,
    });
  }

  console.log("[build-ratios] Completed.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[build-ratios] ${message}`);
  process.exit(1);
});
