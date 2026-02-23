#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { deflateSync } from "node:zlib";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";

const REQUEST_SCHEMA = "studio.local-image-generation.request.v1";
const RESPONSE_SCHEMA = "studio.local-image-generation.response.v1";
const DEFAULT_COREML_MODEL_ID = "local/macos-coreml-stable-diffusion-2-1-base-palettized";
const MOCK_MODEL_ID = "local/macos-procedural-v1";
const INSTALL_HINT = "node scripts/install-local-macos-diffusion-backend.mjs";
const MAX_IMAGE_COUNT = 8;
const MIN_STEP_COUNT = 1;
const MAX_STEP_COUNT = 80;
const DEFAULT_STEP_COUNT = 20;
const DEFAULT_GUIDANCE_SCALE = 7.5;
const DEFAULT_COMPUTE_UNITS = "cpuAndNeuralEngine";
const DEFAULT_SCHEDULER = "pndm";
const DEFAULT_TIMEOUT_MS = 8 * 60_000;

const HOME = homedir();
const DEFAULT_SAMPLE_BINARY = `${HOME}/gits/apps/ml-stable-diffusion/.build/release/StableDiffusionSample`;
const DEFAULT_RESOURCE_PATH = `${HOME}/.systemsculpt/local-image-models/coreml-stable-diffusion-2-1-base-palettized_split_einsum_v2_compiled/coreml-stable-diffusion-2-1-base-palettized_split_einsum_v2_compiled`;

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

function renderMockImage({ prompt, runId, imageIndex }) {
  const seed = fnv1a32(`${prompt}::${runId}::${imageIndex}`);
  const phaseA = ((seed >>> 0) % 1024) / 1024;
  const phaseB = (((seed >>> 10) % 1024) / 1024) * Math.PI;
  const phaseC = (((seed >>> 20) % 1024) / 1024) * Math.PI * 2;
  const freqA = 2.5 + ((seed & 0xff) / 255) * 6.5;
  const freqB = 1.8 + (((seed >>> 8) & 0xff) / 255) * 5.4;
  const freqC = 1.2 + (((seed >>> 16) & 0xff) / 255) * 4.8;
  const promptWeight = (fnv1a32(prompt) % 8192) / 8192;

  return makePng(512, 512, (x, y) => {
    const nx = x / 511;
    const ny = y / 511;
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

function buildMockResponse(request) {
  const prompt = String(request.prompt || "").trim();
  if (!prompt) {
    throw new Error("Request requires a non-empty prompt.");
  }
  const count = clampInteger(request.count, 1, MAX_IMAGE_COUNT, 1);
  const runId = String(request.runId || "").trim();
  parseAspectRatio(request.aspectRatio);

  const images = [];
  for (let index = 0; index < count; index += 1) {
    const png = renderMockImage({ prompt, runId, imageIndex: index });
    images.push({
      mimeType: "image/png",
      base64: png.toString("base64"),
      width: 512,
      height: 512,
    });
  }

  return {
    schema: RESPONSE_SCHEMA,
    modelId: MOCK_MODEL_ID,
    images,
  };
}

async function runCommand(command, args, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: Number(code ?? 1), signal, stdout, stderr, timedOut });
    });
  });
}

async function assertCoreMLResources(resourcePath) {
  const required = [
    "TextEncoder.mlmodelc",
    "Unet.mlmodelc",
    "VAEDecoder.mlmodelc",
    "vocab.json",
    "merges.txt",
  ];
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

  const inputImages = Array.isArray(request.inputImages) ? request.inputImages : [];
  if (inputImages.length > 0) {
    throw new Error(
      "Local macOS diffusion backend currently supports text-to-image only. Remove connected input images and retry."
    );
  }

  const count = clampInteger(request.count, 1, MAX_IMAGE_COUNT, 1);
  const computeUnits =
    String(process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_COMPUTE_UNITS || "").trim() ||
    DEFAULT_COMPUTE_UNITS;
  const stepCount = clampInteger(
    process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_STEP_COUNT,
    MIN_STEP_COUNT,
    MAX_STEP_COUNT,
    DEFAULT_STEP_COUNT
  );
  const guidanceScale = clampFloat(
    process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_GUIDANCE_SCALE,
    0,
    30,
    DEFAULT_GUIDANCE_SCALE
  );
  const scheduler =
    String(process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_SCHEDULER || "").trim() || DEFAULT_SCHEDULER;
  const timeoutMs = clampInteger(
    process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_TIMEOUT_MS,
    30_000,
    30 * 60_000,
    DEFAULT_TIMEOUT_MS
  );
  const disableSafety = boolFromEnv(
    process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_DISABLE_SAFETY,
    true
  );
  const reduceMemory = boolFromEnv(
    process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_REDUCE_MEMORY,
    false
  );

  const requestedAspectRatio = String(request.aspectRatio || "").trim() || "1:1";
  if (requestedAspectRatio !== "1:1") {
    throw new Error(
      `Requested aspect ratio "${requestedAspectRatio}" is not supported by the local diffusion backend yet. Use 1:1.`
    );
  }
  const runId = String(request.runId || "").trim();
  const seed = hashSeed(prompt, runId);

  const sampleBinary = await resolveSampleBinaryPath();
  const resourcePath =
    String(process.env.SYSTEMSCULPT_LOCAL_DIFFUSION_RESOURCE_PATH || "").trim() ||
    DEFAULT_RESOURCE_PATH;

  await assertCoreMLResources(resourcePath);

  const outputDir = await mkdtemp(join(tmpdir(), "systemsculpt-local-diffusion-"));
  try {
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
      throw new Error(
        `Stable Diffusion sample failed with exit code ${commandResult.code}.${details ? ` ${details}` : ""}`
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
      });
    }

    return {
      schema: RESPONSE_SCHEMA,
      modelId: `${DEFAULT_COREML_MODEL_ID}:${computeUnits}`,
      images,
      metadata: {
        backend: "coreml_diffusion",
        sampleBinary,
        resourcePath,
        stepCount,
        guidanceScale,
        scheduler,
        seed,
        requestedAspectRatio,
        actualAspectRatio: "1:1",
      },
    };
  } finally {
    await rm(outputDir, { recursive: true, force: true });
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
