#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { CANONICAL_API_BASE_URL } from "./plugin-build-options.mjs";

export const REQUIRED_PLUGIN_ARTIFACTS = ["manifest.json", "main.js", "styles.css"];

const INLINE_SOURCE_MAP_PATTERN = /[#@]\s*sourceMappingURL=data:/;
const RETIRED_SYSTEMSCULPT_API_HOST = "https://api.systemsculpt.com";
const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_CLIENT_BUNDLE_FRAGMENTS = [
  {
    fragment: "node_modules/@mariozechner/",
    message: "main.js still bundles a retired local AI runtime.",
  },
  {
    fragment: "node_modules/@anthropic-ai/",
    message: "main.js still bundles a provider SDK.",
  },
  {
    fragment: "node_modules/@google/generative-ai/",
    message: "main.js still bundles a provider SDK.",
  },
  {
    fragment: "node_modules/openai/",
    message: "main.js still bundles a provider SDK.",
  },
  {
    fragment: "node_modules/@openai/codex",
    message: "main.js still bundles a retired local AI runtime.",
  },
];

const LOOPBACK_API_BASE_PATTERN =
  /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?\/api\/(?:v1|plugin)\b/gi;
const REQUIRE_CALL_PATTERN = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]),
);
const DESKTOP_HOST_NODE_REQUIRES = new Set([
  "node:fs/promises",
  "node:path",
  "node:os",
  "node:child_process",
]);

function isNodeBuiltin(specifier) {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.replace(/^node:/, ""));
}

function readFileTail(filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  const stats = fs.statSync(filePath);
  const bytesToRead = Math.min(stats.size, maxBytes);
  if (bytesToRead <= 0) {
    return "";
  }

  const buffer = Buffer.alloc(bytesToRead);
  const fileHandle = fs.openSync(filePath, "r");
  try {
    fs.readSync(fileHandle, buffer, 0, bytesToRead, Math.max(stats.size - bytesToRead, 0));
  } finally {
    fs.closeSync(fileHandle);
  }

  return buffer.toString("utf8");
}

function formatBytes(sizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return "unknown size";
  }

  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function inspectPluginArtifacts({ root = process.cwd() } = {}) {
  const resolvedRoot = path.resolve(root);
  const files = Object.fromEntries(
    REQUIRED_PLUGIN_ARTIFACTS.map((fileName) => {
      const filePath = path.join(resolvedRoot, fileName);
      const exists = fs.existsSync(filePath);
      const sizeBytes = exists ? fs.statSync(filePath).size : null;
      return [
        fileName,
        {
          path: filePath,
          exists,
          sizeBytes,
        },
      ];
    })
  );

  const missingFiles = REQUIRED_PLUGIN_ARTIFACTS.filter((fileName) => !files[fileName].exists);
  const problems = [];

  if (missingFiles.length > 0) {
    problems.push(`Missing plugin artifacts: ${missingFiles.join(", ")}`);
  }

  const manifestFile = files["manifest.json"];
  let manifestMobileCompatible = false;
  if (manifestFile.exists) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile.path, "utf8"));
      manifestMobileCompatible = manifest.isDesktopOnly === false;
      if (!manifestMobileCompatible) {
        problems.push("manifest.json must advertise Obsidian Mobile support with isDesktopOnly: false.");
      }
    } catch (error) {
      problems.push(`manifest.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const mainFile = files["main.js"];
  const mainBundle = {
    path: mainFile.path,
    exists: mainFile.exists,
    sizeBytes: mainFile.sizeBytes,
    formattedSize: mainFile.exists ? formatBytes(mainFile.sizeBytes) : "missing",
    hasInlineSourceMap: false,
    hasCanonicalApiBase: false,
    hasRetiredApiHost: false,
    loopbackApiBases: [],
    forbiddenClientFragments: [],
    nodeBuiltinRequires: [],
    mobileUnsafeNodeRequires: [],
  };

  if (mainFile.exists) {
    const tail = readFileTail(mainFile.path);
    mainBundle.hasInlineSourceMap = INLINE_SOURCE_MAP_PATTERN.test(tail);
    if (mainBundle.hasInlineSourceMap) {
      problems.push(
        `main.js still contains an inline source map (${mainBundle.formattedSize}); plugin sync must use a production build.`
      );
    }

    const bundleText = fs.readFileSync(mainFile.path, "utf8");
    mainBundle.hasCanonicalApiBase = bundleText.includes(CANONICAL_API_BASE_URL);
    if (!mainBundle.hasCanonicalApiBase) {
      problems.push(
        `main.js does not contain the canonical SystemSculpt API base ${CANONICAL_API_BASE_URL}.`,
      );
    }

    mainBundle.hasRetiredApiHost = bundleText.includes(RETIRED_SYSTEMSCULPT_API_HOST);
    if (mainBundle.hasRetiredApiHost) {
      problems.push(`main.js contains the retired SystemSculpt API host ${RETIRED_SYSTEMSCULPT_API_HOST}.`);
    }

    mainBundle.loopbackApiBases = Array.from(
      new Set(bundleText.match(LOOPBACK_API_BASE_PATTERN) || []),
    );
    if (mainBundle.loopbackApiBases.length > 0) {
      problems.push(
        `main.js contains a loopback QA API base: ${mainBundle.loopbackApiBases.join(", ")}.`,
      );
    }

    mainBundle.forbiddenClientFragments = FORBIDDEN_CLIENT_BUNDLE_FRAGMENTS.filter(({ fragment }) =>
      bundleText.includes(fragment)
    ).map(({ fragment, message }) => ({
      fragment,
      message,
    }));

    for (const match of mainBundle.forbiddenClientFragments) {
      problems.push(`${match.message} (${mainBundle.formattedSize})`);
    }

    mainBundle.nodeBuiltinRequires = Array.from(bundleText.matchAll(REQUIRE_CALL_PATTERN))
      .map((match) => match[1])
      .filter(isNodeBuiltin);
    mainBundle.mobileUnsafeNodeRequires = Array.from(
      new Set(
        mainBundle.nodeBuiltinRequires.filter(
          (specifier) => !DESKTOP_HOST_NODE_REQUIRES.has(specifier),
        ),
      ),
    );
    if (mainBundle.mobileUnsafeNodeRequires.length > 0) {
      problems.push(
        `main.js loads Node builtins outside the desktop host seam: ${mainBundle.mobileUnsafeNodeRequires.join(", ")}.`,
      );
    }
  }

  return {
    root: resolvedRoot,
    files,
    missingFiles,
    manifestMobileCompatible,
    mainBundle,
    problems,
    ok: problems.length === 0,
  };
}

export function formatArtifactProblems(inspection) {
  if (!inspection || !Array.isArray(inspection.problems) || inspection.problems.length === 0) {
    return "Plugin artifacts look valid.";
  }

  return inspection.problems.join(" ");
}

export function assertProductionPluginArtifacts(options = {}) {
  const inspection = inspectPluginArtifacts(options);
  if (!inspection.ok) {
    throw new Error(formatArtifactProblems(inspection));
  }
  return inspection;
}

export function buildProductionPlugin({
  root = process.cwd(),
  stdio = "inherit",
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const releaseEnv = {
    ...env,
    SYSTEMSCULPT_API_BASE_URL: CANONICAL_API_BASE_URL,
  };
  const result = spawnSyncImpl("npm", ["run", "build"], {
    cwd: resolvedRoot,
    env: releaseEnv,
    stdio,
    encoding: "utf8",
  });

  if (result?.error) {
    throw result.error;
  }

  if ((result?.status ?? 1) !== 0) {
    const output = [result?.stderr, result?.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`npm run build failed.${output ? `\n${output}` : ""}`);
  }

  return assertProductionPluginArtifacts({ root: resolvedRoot });
}
