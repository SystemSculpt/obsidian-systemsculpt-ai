import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CONTRACT_VERSION = "plugin-release-v1";
const PLUGIN_ID = "systemsculpt-ai";
const RELEASE_URL_PREFIX = "https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/tag/";
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const MAX_RESPONSE_BYTES = 8 * 1024;

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function createPluginReleaseMetadata({
  manifestVersion,
  tagName,
  releaseUrl,
  publishedAt,
}) {
  const version = String(manifestVersion || "").trim();
  const tag = String(tagName || "").trim();
  const url = String(releaseUrl || "").trim();
  const published = String(publishedAt || "").trim();
  if (!EXACT_VERSION.test(version)) throw new Error("manifest.json version must use exact x.y.z syntax");
  if (tag !== version) throw new Error(`Release tag ${tag || "<missing>"} must match manifest.json ${version}`);
  if (url !== `${RELEASE_URL_PREFIX}${tag}`) throw new Error("Release URL does not match the SystemSculpt release tag");
  if (!published || Number.isNaN(Date.parse(published))) throw new Error("Release publication time is invalid");
  return Object.freeze({
    contract_version: CONTRACT_VERSION,
    plugin_id: PLUGIN_ID,
    latest_version: version,
    release_url: url,
    published_at: published,
  });
}

export function parsePublishedPluginRelease(value) {
  if (!exactKeys(value, [
    "contract_version",
    "plugin_id",
    "latest_version",
    "release_url",
    "published_at",
  ])) return null;
  try {
    const expected = createPluginReleaseMetadata({
      manifestVersion: value.latest_version,
      tagName: value.latest_version,
      releaseUrl: value.release_url,
      publishedAt: value.published_at,
    });
    return value.contract_version === CONTRACT_VERSION && value.plugin_id === PLUGIN_ID
      ? expected
      : null;
  } catch {
    return null;
  }
}

export async function verifyPublishedPluginRelease({
  url,
  expectedVersion,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxAttempts = 25,
  retryDelayMs = 5_000,
}) {
  let lastProblem = "no response";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json" }, cache: "no-store" });
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error("response is too large");
      const release = response.ok ? parsePublishedPluginRelease(JSON.parse(text)) : null;
      if (release?.latest_version === expectedVersion) return release;
      lastProblem = response.ok
        ? `expected ${expectedVersion}, received ${release?.latest_version ?? "invalid metadata"}`
        : `HTTP ${response.status}`;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
    if (attempt < maxAttempts) await sleepImpl(retryDelayMs);
  }
  throw new Error(`Published release metadata verification failed: ${lastProblem}`);
}

export function assertReleaseDoesNotDowngrade(candidate, currentValue) {
  const current = parsePublishedPluginRelease(currentValue);
  if (!current) throw new Error("Current release metadata does not match the release contract");
  if (compareVersions(candidate.latest_version, current.latest_version) < 0) {
    throw new Error(
      `Release ${candidate.latest_version} cannot replace newer metadata ${current.latest_version}`,
    );
  }
}

function releaseInput(root = process.cwd(), env = process.env) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  return createPluginReleaseMetadata({
    manifestVersion: manifest.version,
    tagName: env.SYSTEMSCULPT_RELEASE_TAG,
    releaseUrl: env.SYSTEMSCULPT_RELEASE_URL,
    publishedAt: env.SYSTEMSCULPT_RELEASE_PUBLISHED_AT,
  });
}

async function main() {
  const metadata = releaseInput();
  const currentArgument = process.argv.slice(2).find((argument) => argument.startsWith("--assert-not-older="));
  if (currentArgument) {
    const currentPath = currentArgument.slice("--assert-not-older=".length);
    assertReleaseDoesNotDowngrade(metadata, JSON.parse(fs.readFileSync(currentPath, "utf8")));
    console.info(`[release-metadata] ${metadata.latest_version} does not downgrade published metadata.`);
    return;
  }
  const verifyArgument = process.argv.slice(2).find((argument) => argument.startsWith("--verify-url="));
  if (verifyArgument) {
    await verifyPublishedPluginRelease({
      url: verifyArgument.slice("--verify-url=".length),
      expectedVersion: metadata.latest_version,
    });
    console.info(`[release-metadata] Published ${metadata.latest_version} verified.`);
    return;
  }
  if (process.argv.includes("--check")) {
    console.info(`[release-metadata] ${metadata.latest_version} is valid.`);
    return;
  }
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(`[release-metadata] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
