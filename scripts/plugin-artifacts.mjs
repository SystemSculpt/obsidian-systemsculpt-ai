#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const REQUIRED_PLUGIN_ARTIFACTS = ["manifest.json", "main.js", "styles.css"];

const INLINE_SOURCE_MAP_PATTERN = /[#@]\s*sourceMappingURL=data:/;
const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_MAIN_BUNDLE_FRAGMENTS = [
  {
    fragment: 'const __systemsculpt_import_meta_url__ = require("node:url").pathToFileURL(__filename).href;',
    message:
      "main.js still uses a node:url import-meta banner that breaks mobile plugin startup before load.",
  },
  {
    fragment: "node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/components/index.js",
    message:
      "main.js still bundles the Pi interactive component index; expected the core SDK surface only.",
  },
  {
    fragment: "node_modules/@mariozechner/pi-coding-agent/dist/main.js",
    message:
      "main.js still bundles the Pi CLI entrypoint; expected the core SDK surface only.",
  },
];

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

  const mainFile = files["main.js"];
  const mainBundle = {
    path: mainFile.path,
    exists: mainFile.exists,
    sizeBytes: mainFile.sizeBytes,
    formattedSize: mainFile.exists ? formatBytes(mainFile.sizeBytes) : "missing",
    hasInlineSourceMap: false,
    forbiddenFragments: [],
  };

  if (mainFile.exists) {
    const tail = readFileTail(mainFile.path);
    mainBundle.hasInlineSourceMap = INLINE_SOURCE_MAP_PATTERN.test(tail);
    if (mainBundle.hasInlineSourceMap) {
      problems.push(
        `main.js still contains an inline source map (${mainBundle.formattedSize}); Android/mobile sync must use a production build.`
      );
    }

    const bundleText = fs.readFileSync(mainFile.path, "utf8");
    mainBundle.forbiddenFragments = FORBIDDEN_MAIN_BUNDLE_FRAGMENTS.filter(({ fragment }) =>
      bundleText.includes(fragment)
    ).map(({ fragment, message }) => ({
      fragment,
      message,
    }));

    for (const match of mainBundle.forbiddenFragments) {
      problems.push(`${match.message} (${mainBundle.formattedSize})`);
    }
  }

  return {
    root: resolvedRoot,
    files,
    missingFiles,
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
  const result = spawnSyncImpl("npm", ["run", "build"], {
    cwd: resolvedRoot,
    env,
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
