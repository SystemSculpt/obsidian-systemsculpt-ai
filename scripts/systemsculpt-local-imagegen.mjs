#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { deflateSync } from "node:zlib";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";

const REQUEST_SCHEMA = "studio.local-image-generation.request.v1";
const RESPONSE_SCHEMA = "studio.local-image-generation.response.v1";
const MODEL_MANIFEST_SCHEMA = "studio.local-diffusion.model-manifest.v1";

const DEFAULT_COREML_MODEL_ID = "local/macos-coreml-stable-diffusion-2-1-base-palettized";
const MOCK_MODEL_ID = "local/macos-procedural-v1";
const INSTALL_HINT = "node scripts/install-local-macos-diffusion-backend.mjs";
const MAX_IMAGE_COUNT = 8;
const MIN_STEP_COUNT = 1;
const MAX_STEP_COUNT = 80;
const DEFAULT_COMPUTE_UNITS = "cpuAndNeuralEngine";
const DEFAULT_SCHEDULER = "pndm";
const DEFAULT_TIMEOUT_MS = 8 * 60_000;
const DEFAULT_LOCAL_ASPECT_RATIO = "1:1";
const DEFAULT_QUALITY_PRESET = "balanced";
const DEFAULT_REFERENCE_INFLUENCE = "balanced";

const HOME = homedir();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SAMPLE_BINARY = `${HOME}/gits/apps/ml-stable-diffusion/.build/release/StableDiffusionSample`;
const DEFAULT_RESOURCE_PATH = `${HOME}/.systemsculpt/local-image-models/coreml-stable-diffusion-2-1-base-palettized_split_einsum_v2_compiled/coreml-stable-diffusion-2-1-base-palettized_split_einsum_v2_compiled`;
const DEFAULT_MODEL_MANIFEST_PATH = join(SCRIPT_DIR, "local-diffusion", "model-manifest.json");

const REQUIRED_RESOURCE_FILES_TEXT_TO_IMAGE = [
  "TextEncoder.mlmodelc",
  "Unet.mlmodelc",
  "VAEDecoder.mlmodelc",
  "vocab.json",
  "merges.txt",
];
const REQUIRED_RESOURCE_FILES_IMAGE_TO_IMAGE = [
  ...REQUIRED_RESOURCE_FILES_TEXT_TO_IMAGE,
  "VAEEncoder.mlmodelc",
];

const QUALITY_PRESET_CONFIG = {
  fast: {
    stepCount: 14,
    guidanceScale: 7,
  },
  balanced: {
    stepCount: 20,
    guidanceScale: 7.5,
  },
  high: {
    stepCount: 32,
    guidanceScale: 8,
  },
};

const REFERENCE_INFLUENCE_STRENGTH = {
  subtle: 0.75,
  balanced: 0.55,
  strong: 0.35,
};

const MOCK_RATIO_DIMENSIONS = {
  "1:1": { width: 512, height: 512 },
  "4:3": { width: 768, height: 576 },
  "3:4": { width: 576, height: 768 },
  "16:9": { width: 1024, height: 576 },
  "9:16": { width: 576, height: 1024 },
};

process.stdout.on("error", (error) => {
  if (error && error.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function clampFloat(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeBackend(raw) {
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) return "coreml_diffusion";
  if (normalized === "mock" || normalized === "procedural") return "mock";
  if (normalized === "coreml" || normalized === "coreml_diffusion") return "coreml_diffusion";
  throw new Error(
    `Unsupported SYSTEMSCULPT_LOCAL_IMAGEGEN_BACKEND value "${raw}". Use "coreml_diffusion" or "mock".`
  );
}

function boolFromEnv(raw, fallback) {
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

function substituteHome(value) {
  return String(value || "").replaceAll("${HOME}", HOME);
}

async function pathExists(path, executable = false) {
  if (!path) return false;
  try {
    await access(path, executable ? fsConstants.X_OK : fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length >>> 0, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function makePng(width, height, pixelAt) {
  const scanlineLength = width * 4 + 1;
  const raw = Buffer.alloc(scanlineLength * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * scanlineLength;
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixelAt(x, y);
      const offset = rowOffset + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }

  const compressed = deflateSync(raw, { level: 9 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width >>> 0, 0);
  ihdr.writeUInt32BE(height >>> 0, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function clampChannel(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

function fnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function parseArgs(argv) {
  const args = { requestPath: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (token === "--request") {
      args.requestPath = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (token === "-h" || token === "--help") {
      process.stderr.write(
        "Usage: systemsculpt-local-imagegen --request <request-json-path>\n"
      );
      process.exit(0);
    }
  }
  return args;
}

async function loadRequest(requestPath) {
  if (!requestPath) {
    throw new Error("Missing --request <path> argument.");
  }
  const raw = await readFile(requestPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid request JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request payload must be a JSON object.");
  }
  const schema = String(parsed.schema || "").trim();
  if (schema && schema !== REQUEST_SCHEMA) {
    throw new Error(`Unsupported request schema "${schema}".`);
  }
  return parsed;
}

function parseAspectRatio(raw) {
  const normalized = String(raw || "").trim();
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!match) {
    return 1;
  }
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return 1;
  }
  return w / h;
}

function renderMockImage({ prompt, runId, imageIndex, width, height }) {
  const seed = fnv1a32(`${prompt}::${runId}::${imageIndex}`);
  const maxX = Math.max(1, width - 1);
  const maxY = Math.max(1, height - 1);
  const phaseA = ((seed >>> 0) % 1024) / 1024;
  const phaseB = (((seed >>> 10) % 1024) / 1024) * Math.PI;
  const phaseC = (((seed >>> 20) % 1024) / 1024) * Math.PI * 2;
  const freqA = 2.5 + ((seed & 0xff) / 255) * 6.5;
  const freqB = 1.8 + (((seed >>> 8) & 0xff) / 255) * 5.4;
  const freqC = 1.2 + (((seed >>> 16) & 0xff) / 255) * 4.8;
  const promptWeight = (fnv1a32(prompt) % 8192) / 8192;

  return makePng(width, height, (x, y) => {
    const nx = x / maxX;
    const ny = y / maxY;
    const radial = Math.hypot(nx - 0.5, ny - 0.5);
    const wave1 = Math.sin((nx * freqA + ny * (freqA * 0.5) + phaseA) * Math.PI * 2);
    const wave2 = Math.cos((ny * freqB - nx * (freqB * 0.35) + phaseB));
    const wave3 = Math.sin((radial * freqC + phaseC) * Math.PI * 2);
    const blend = wave1 * 0.45 + wave2 * 0.35 + wave3 * 0.2;

    const baseR = 72 + promptWeight * 96;
    const baseG = 84 + (1 - promptWeight) * 92;
    const baseB = 110 + Math.abs(0.5 - promptWeight) * 120;

    const r = clampChannel(baseR + blend * 120 + wave2 * 40);
    const g = clampChannel(baseG + blend * 98 - wave1 * 32);
    const b = clampChannel(baseB + blend * 110 + wave3 * 55);
    return [r, g, b, 255];
  });
}

function normalizeAspectRatioLabel(raw, availableRatios = []) {
  const compact = String(raw || "").trim().replaceAll(" ", "");
  if (!compact) {
    return DEFAULT_LOCAL_ASPECT_RATIO;
  }
  if (availableRatios.includes(compact)) {
    return compact;
  }
  return compact;
}

function normalizeLocalQualityPreset(raw) {
  const normalized = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
  if (!normalized) {
    return DEFAULT_QUALITY_PRESET;
  }
  if (normalized === "fast" || normalized === "draft") return "fast";
  if (normalized === "high" || normalized === "highdetail" || normalized === "detail") return "high";
  return "balanced";
}

function normalizeReferenceInfluence(raw) {
  const normalized = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
  if (!normalized) {
    return DEFAULT_REFERENCE_INFLUENCE;
  }
  if (normalized === "low" || normalized === "subtle") return "subtle";
  if (normalized === "high" || normalized === "strong") return "strong";
  return "balanced";
}

function normalizeLocalOptions(request) {
  const localOptions = isRecord(request.localOptions)
    ? request.localOptions
    : {};
  const qualityRaw =
    localOptions.quality ??
    request.quality ??
    request.qualityPreset ??
    "";
  const referenceInfluenceRaw =
    localOptions.referenceInfluence ??
    request.referenceInfluence ??
    "";
  return {
    qualityPreset: normalizeLocalQualityPreset(qualityRaw),
    referenceInfluence: normalizeReferenceInfluence(referenceInfluenceRaw),
  };
}

function collectInputImagePaths(rawInputImages) {
  if (!Array.isArray(rawInputImages)) {
    return [];
  }
  const paths = [];
  for (const item of rawInputImages) {
    if (!isRecord(item)) {
      continue;
    }
    const preferred = String(item.stagedPath || "").trim();
    const fallback = String(item.path || "").trim();
    const selected = preferred || fallback;
    if (selected) {
      paths.push(selected);
    }
  }
  return paths;
}

function resolveMockDimensions(aspectRatio) {
  const preset = MOCK_RATIO_DIMENSIONS[aspectRatio];
  if (preset) {
    return preset;
  }
  const ratio = parseAspectRatio(aspectRatio);
  const baseHeight = 512;
  const rawWidth = Math.round(baseHeight * ratio);
  const width = clampInteger(rawWidth, 256, 1024, 512);
  return {
    width,
    height: baseHeight,
  };
}

function buildMockResponse(request) {
  const prompt = String(request.prompt || "").trim();
  if (!prompt) {
    throw new Error("Request requires a non-empty prompt.");
  }
  const count = clampInteger(request.count, 1, MAX_IMAGE_COUNT, 1);
  const runId = String(request.runId || "").trim();
  const normalizedAspectRatio = normalizeAspectRatioLabel(request.aspectRatio, Object.keys(MOCK_RATIO_DIMENSIONS));
  const dimensions = resolveMockDimensions(normalizedAspectRatio);

  const images = [];
  for (let index = 0; index < count; index += 1) {
    const png = renderMockImage({
      prompt,
      runId,
      imageIndex: index,
      width: dimensions.width,
      height: dimensions.height,
    });
    images.push({
      mimeType: "image/png",
      base64: png.toString("base64"),
      width: dimensions.width,
      height: dimensions.height,
    });
  }

  return {
    schema: RESPONSE_SCHEMA,
    modelId: MOCK_MODEL_ID,
    images,
    metadata: {
      backend: "mock",
      aspectRatio: normalizedAspectRatio,
      width: dimensions.width,
      height: dimensions.height,
    },
  };
}

async function runCommand(command, args, timeoutMs, cwd = process.cwd()) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code: Number(code ?? 1), signal, stdout, stderr, timedOut });
    });
  });
}

function parseIntegerFromText(raw) {
  const parsed = Number(String(raw || "").trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.floor(parsed);
}

async function readImageDimensions(path) {
  const result = await runCommand("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], 30_000);
  if (result.timedOut) {
    throw new Error(`Timed out while reading image metadata via sips for "${path}".`);
  }
  if (result.code !== 0) {
    const details = String(result.stderr || result.stdout || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 320);
    throw new Error(`sips failed to read image metadata for "${path}".${details ? ` ${details}` : ""}`);
  }
  const text = `${result.stdout}\n${result.stderr}`;
  const widthMatch = text.match(/pixelWidth:\s*(\d+)/i);
  const heightMatch = text.match(/pixelHeight:\s*(\d+)/i);
  const width = parseIntegerFromText(widthMatch?.[1]);
  const height = parseIntegerFromText(heightMatch?.[1]);
  if (!width || !height || width <= 0 || height <= 0) {
    throw new Error(`Could not parse source image dimensions from sips output for "${path}".`);
  }
  return { width, height };
}

async function runSips(args, contextLabel) {
  const result = await runCommand("sips", args, 60_000);
  if (result.timedOut) {
    throw new Error(`sips timed out while ${contextLabel}.`);
  }
  if (result.code !== 0) {
    const details = String(result.stderr || result.stdout || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 420);
    throw new Error(`sips failed while ${contextLabel}.${details ? ` ${details}` : ""}`);
  }
}

async function preprocessReferenceImage(sourcePath, ratioSpec, workingDir) {
  const exists = await pathExists(sourcePath);
  if (!exists) {
    throw new Error(`Reference image path does not exist: "${sourcePath}".`);
  }

  const targetWidth = clampInteger(ratioSpec.width, 64, 8192, 512);
  const targetHeight = clampInteger(ratioSpec.height, 64, 8192, 512);

  const normalizedPath = join(workingDir, "reference-normalized.png");
  const resizedPath = join(workingDir, "reference-resized.png");
  const finalPath = join(workingDir, "reference-final.png");

  await runSips(
    ["-s", "format", "png", sourcePath, "--out", normalizedPath],
    `normalizing reference image "${sourcePath}"`
  );

  const sourceSize = await readImageDimensions(normalizedPath);
  if (sourceSize.width === targetWidth && sourceSize.height === targetHeight) {
    return normalizedPath;
  }

  const scale = Math.max(targetWidth / sourceSize.width, targetHeight / sourceSize.height);
  const resizedWidth = Math.max(targetWidth, Math.round(sourceSize.width * scale));
  const resizedHeight = Math.max(targetHeight, Math.round(sourceSize.height * scale));

  await runSips(
    [
      "--resampleHeightWidth",
      String(resizedHeight),
      String(resizedWidth),
      normalizedPath,
      "--out",
      resizedPath,
    ],
    `resizing reference image to cover ${targetWidth}x${targetHeight}`
  );

  await runSips(
    [
      "--cropToHeightWidth",
      String(targetHeight),
      String(targetWidth),
      resizedPath,
      "--out",
      finalPath,
    ],
    `cropping reference image to ${targetWidth}x${targetHeight}`
  );

  return finalPath;
}

async function loadModelManifest() {
  const configuredPath = String(process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_MANIFEST_PATH || "").trim();
  const manifestPath = resolve(configuredPath || DEFAULT_MODEL_MANIFEST_PATH);
  const raw = await readFile(manifestPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid model manifest JSON at "${manifestPath}": ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Model manifest at "${manifestPath}" must be a JSON object.`);
  }
  if (String(parsed.schema || "").trim() !== MODEL_MANIFEST_SCHEMA) {
    throw new Error(
      `Model manifest schema mismatch at "${manifestPath}". Expected "${MODEL_MANIFEST_SCHEMA}".`
    );
  }
  if (!isRecord(parsed.ratios)) {
    throw new Error(`Model manifest at "${manifestPath}" is missing a valid "ratios" object.`);
  }
  return {
    manifestPath,
    ratios: parsed.ratios,
  };
}

function resolveRatioSpec(requestedAspectRatio, manifestRatios) {
  const availableRatios = Object.keys(manifestRatios);
  if (availableRatios.length === 0) {
    throw new Error("Local diffusion model manifest has no ratio entries.");
  }
  const normalizedAspectRatio = normalizeAspectRatioLabel(requestedAspectRatio, availableRatios);
  const ratioSpec = manifestRatios[normalizedAspectRatio];
  if (!isRecord(ratioSpec)) {
    throw new Error(
      `Aspect ratio "${normalizedAspectRatio}" is not available in local model manifest. Supported: ${availableRatios.join(", ")}.`
    );
  }
  const width = clampInteger(ratioSpec.width, 64, 8192, 0);
  const height = clampInteger(ratioSpec.height, 64, 8192, 0);
  if (!width || !height) {
    throw new Error(
      `Aspect ratio "${normalizedAspectRatio}" in model manifest is missing valid width/height.`
    );
  }
  return {
    ratioLabel: normalizedAspectRatio,
    width,
    height,
    resourcePath: String(ratioSpec.resourcePath || "").trim(),
  };
}

function resolveResourcePathForRatio(ratioLabel, ratioSpec) {
  const envOverride = String(process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_RESOURCE_PATH || "").trim();
  if (envOverride) {
    return {
      resourcePath: resolve(substituteHome(envOverride)),
      source: "env_override",
    };
  }

  const manifestResourcePath = String(ratioSpec.resourcePath || "").trim();
  if (manifestResourcePath) {
    return {
      resourcePath: resolve(substituteHome(manifestResourcePath)),
      source: "manifest",
    };
  }

  if (ratioLabel === DEFAULT_LOCAL_ASPECT_RATIO) {
    return {
      resourcePath: DEFAULT_RESOURCE_PATH,
      source: "legacy_default",
    };
  }

  throw new Error(
    `Aspect ratio "${ratioLabel}" has no configured resource path. Run ${INSTALL_HINT} to provision native ratio resources.`
  );
}

async function assertCoreMLResources(resourcePath, needsVaeEncoder) {
  const required = needsVaeEncoder
    ? REQUIRED_RESOURCE_FILES_IMAGE_TO_IMAGE
    : REQUIRED_RESOURCE_FILES_TEXT_TO_IMAGE;

  for (const item of required) {
    const exists = await pathExists(join(resourcePath, item), false);
    if (!exists) {
      throw new Error(
        `Stable Diffusion resources are missing "${item}" under "${resourcePath}". Install resources, then retry. ${INSTALL_HINT}`
      );
    }
  }
}

async function resolveSampleBinaryPath() {
  const configured = String(process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_SAMPLE_BIN || "").trim();
  if (configured) {
    const exists = await pathExists(configured, true);
    if (!exists) {
      throw new Error(
        `SYSTEMSCULPT_LOCAL_DIFFUSION_SAMPLE_BIN points to a non-executable path: "${configured}".`
      );
    }
    return configured;
  }
  if (await pathExists(DEFAULT_SAMPLE_BINARY, true)) {
    return DEFAULT_SAMPLE_BINARY;
  }
  return "stable-diffusion-sample";
}

function hashSeed(prompt, runId) {
  const hash = fnv1a32(`${prompt}::${runId || "local"}`);
  return Math.max(1, hash);
}

async function buildCoreMLResponse(request) {
  const prompt = String(request.prompt || "").trim();
  if (!prompt) {
    throw new Error("Request requires a non-empty prompt.");
  }

  const count = clampInteger(request.count, 1, MAX_IMAGE_COUNT, 1);
  const requestedAspectRatio = String(request.aspectRatio || "").trim() || DEFAULT_LOCAL_ASPECT_RATIO;
  const runId = String(request.runId || "").trim();
  const seed = hashSeed(prompt, runId);

  const { qualityPreset, referenceInfluence } = normalizeLocalOptions(request);
  const qualityConfig = QUALITY_PRESET_CONFIG[qualityPreset] || QUALITY_PRESET_CONFIG[DEFAULT_QUALITY_PRESET];
  const referenceStrength =
    REFERENCE_INFLUENCE_STRENGTH[referenceInfluence] ||
    REFERENCE_INFLUENCE_STRENGTH[DEFAULT_REFERENCE_INFLUENCE];

  const computeUnits =
    String(process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_COMPUTE_UNITS || "").trim() ||
    DEFAULT_COMPUTE_UNITS;
  const envStepCountRaw = String(process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_STEP_COUNT || "").trim();
  const envGuidanceScaleRaw = String(process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_GUIDANCE_SCALE || "").trim();
  const stepCount = clampInteger(
    envStepCountRaw || qualityConfig.stepCount,
    MIN_STEP_COUNT,
    MAX_STEP_COUNT,
    qualityConfig.stepCount
  );
  const guidanceScale = clampFloat(
    envGuidanceScaleRaw || qualityConfig.guidanceScale,
    0,
    30,
    qualityConfig.guidanceScale
  );
  const scheduler =
    String(process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_SCHEDULER || "").trim() || DEFAULT_SCHEDULER;
  const timeoutMs = clampInteger(
    process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_TIMEOUT_MS,
    30_000,
    30 * 60_000,
    DEFAULT_TIMEOUT_MS
  );
  const disableSafety = boolFromEnv(process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_DISABLE_SAFETY, true);
  const reduceMemory = boolFromEnv(process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_REDUCE_MEMORY, false);

  const manifest = await loadModelManifest();
  const ratioSpec = resolveRatioSpec(requestedAspectRatio, manifest.ratios);
  const resourceResolution = resolveResourcePathForRatio(ratioSpec.ratioLabel, ratioSpec);
  const resourcePath = resourceResolution.resourcePath;

  const inputImagePaths = collectInputImagePaths(request.inputImages);
  const warnings = [];
  if (inputImagePaths.length > 1) {
    warnings.push(
      `Received ${inputImagePaths.length} reference images. Local backend currently uses only the first image.`
    );
  }
  const selectedInputImagePath = inputImagePaths[0] || "";

  await assertCoreMLResources(resourcePath, Boolean(selectedInputImagePath));

  const sampleBinary = await resolveSampleBinaryPath();

  const workDir = await mkdtemp(join(tmpdir(), "systemsculpt-local-diffusion-"));
  const outputDir = join(workDir, "output");
  await mkdir(outputDir, { recursive: true });

  try {
    let preparedReferenceImagePath = "";
    if (selectedInputImagePath) {
      preparedReferenceImagePath = await preprocessReferenceImage(
        selectedInputImagePath,
        ratioSpec,
        workDir
      );
    }

    const args = [
      prompt,
      "--resource-path",
      resourcePath,
      "--output-path",
      outputDir,
      "--compute-units",
      computeUnits,
      "--step-count",
      String(stepCount),
      "--image-count",
      String(count),
      "--seed",
      String(seed),
      "--guidance-scale",
      String(guidanceScale),
      "--scheduler",
      scheduler,
    ];

    if (preparedReferenceImagePath) {
      args.push("--image", preparedReferenceImagePath, "--strength", String(referenceStrength));
    }

    if (disableSafety) {
      args.push("--disable-safety");
    }
    if (reduceMemory) {
      args.push("--reduce-memory");
    }

    let commandResult;
    try {
      commandResult = await runCommand(sampleBinary, args, timeoutMs);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw new Error(
          `Stable Diffusion sample binary "${sampleBinary}" was not found. Install the local diffusion backend, then retry. ${INSTALL_HINT}`
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to launch Stable Diffusion sample binary: ${message}`);
    }

    if (commandResult.timedOut) {
      throw new Error(
        `Stable Diffusion generation timed out after ${timeoutMs}ms. Reduce step count or image count and retry.`
      );
    }

    if (commandResult.code !== 0) {
      const details = String(commandResult.stderr || commandResult.stdout || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 600);
      const shapeHint = details.includes("sampleInputShapeNotCorrect")
        ? " Ensure native ratio resources are installed and reference image preprocessing completed successfully."
        : "";
      throw new Error(
        `Stable Diffusion sample failed with exit code ${commandResult.code}.${details ? ` ${details}` : ""}${shapeHint}`
      );
    }

    const fileNames = (await readdir(outputDir))
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .sort((a, b) => a.localeCompare(b));
    const finalFiles = fileNames.filter((name) => name.endsWith(".final.png"));
    const selected = (finalFiles.length > 0 ? finalFiles : fileNames).slice(0, count);

    if (selected.length === 0) {
      throw new Error(
        `Stable Diffusion sample completed but did not produce PNG files in "${outputDir}".`
      );
    }

    const images = [];
    for (const fileName of selected) {
      const absolutePath = join(outputDir, fileName);
      const bytes = await readFile(absolutePath);
      images.push({
        mimeType: "image/png",
        base64: bytes.toString("base64"),
        fileName,
        width: ratioSpec.width,
        height: ratioSpec.height,
      });
    }

    return {
      schema: RESPONSE_SCHEMA,
      modelId: `${DEFAULT_COREML_MODEL_ID}:${computeUnits}`,
      images,
      warnings,
      metadata: {
        backend: "coreml_diffusion",
        sampleBinary,
        resourcePath,
        resourcePathSource: resourceResolution.source,
        manifestPath: manifest.manifestPath,
        stepCount,
        guidanceScale,
        scheduler,
        seed,
        requestedAspectRatio: ratioSpec.ratioLabel,
        actualAspectRatio: ratioSpec.ratioLabel,
        width: ratioSpec.width,
        height: ratioSpec.height,
        qualityPreset,
        referenceInfluence,
        referenceStrength,
        usedReferenceImage: Boolean(selectedInputImagePath),
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const request = await loadRequest(args.requestPath);
  const backend = normalizeBackend(process.env.SYSTEMSCULPT_LOCAL_IMAGEGEN_BACKEND);
  const payload =
    backend === "mock" ? buildMockResponse(request) : await buildCoreMLResponse(request);
  process.stdout.write(JSON.stringify(payload));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[systemsculpt-local-imagegen] ${message}\n`);
  process.exit(1);
});
