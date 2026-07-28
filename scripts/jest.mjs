import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  HOSTED_JEST_PHASE_MARKER_FILE,
  writeJsonEvidence,
} from "./build-provenance.mjs";
import { nodeRequireInvocation } from "./platform-portability.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const jestBin = path.resolve(__dirname, "..", "node_modules", "jest", "bin", "jest.js");
const preload = path.resolve(__dirname, "jest-preload.cjs");

const rawArgs = process.argv.slice(2);
let strictConsole = false;
let debugConsole = false;
const jestArgs = [];

for (const arg of rawArgs) {
  if (arg === "--strict-console") {
    strictConsole = true;
    continue;
  }
  if (arg === "--debug-console") {
    debugConsole = true;
    continue;
  }
  jestArgs.push(arg);
}

const seedIndex = jestArgs.findIndex((arg) =>
  arg === "--seed" || arg.startsWith("--seed="));
let replaySeed = null;
if (jestArgs.includes("--randomize") && seedIndex < 0) {
  const requestedSeed = process.env.SYSTEMSCULPT_TEST_SEED?.trim();
  const seed = requestedSeed
    ? Number(requestedSeed)
    : randomInt(-2147483648, 2147483648);
  if (!Number.isInteger(seed) || seed < -2147483648 || seed > 2147483647) {
    throw new Error("SYSTEMSCULPT_TEST_SEED must be a signed 32-bit integer.");
  }
  jestArgs.push(`--seed=${seed}`);
  replaySeed = seed;
  console.log(`[tests] Jest seed: ${seed}`);
} else if (seedIndex >= 0) {
  const seedArgument = jestArgs[seedIndex];
  const seed = seedArgument.startsWith("--seed=")
    ? seedArgument.slice("--seed=".length)
    : jestArgs[seedIndex + 1];
  if (seed) {
    replaySeed = Number(seed);
    console.log(`[tests] Jest seed: ${seed}`);
  }
}

const evidenceDirectory = process.env.SYSTEMSCULPT_TEST_EVIDENCE_DIR?.trim();
if (evidenceDirectory) {
  const resolvedDirectory = path.resolve(process.cwd(), evidenceDirectory);
  const jestEvidenceRecord = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    seed: replaySeed,
    cwd: process.cwd(),
    argv: jestArgs,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  writeJsonEvidence(
    path.join(resolvedDirectory, HOSTED_JEST_PHASE_MARKER_FILE),
    jestEvidenceRecord,
  );
  const evidencePath = path.join(
    resolvedDirectory,
    `jest-${Date.now()}-${process.pid}-${randomBytes(3).toString("hex")}.json`,
  );
  writeJsonEvidence(evidencePath, jestEvidenceRecord);
}

const child = spawn(
  process.execPath,
  nodeRequireInvocation(preload, [jestBin, ...jestArgs]),
  {
  stdio: "inherit",
  env: {
    ...process.env,
    ...(strictConsole ? { SYSTEMSCULPT_TEST_STRICT_CONSOLE: "1" } : {}),
    ...(debugConsole ? { SYSTEMSCULPT_TEST_DEBUG: "1" } : {}),
  },
  },
);

child.on("exit", (code, signal) => {
  if (typeof code === "number") process.exit(code);
  if (signal) process.kill(process.pid, signal);
  process.exit(1);
});
