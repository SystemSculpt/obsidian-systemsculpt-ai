#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import process from "node:process";
import {
  CANONICAL_API_BASE_URL,
  LOCAL_AGENT_API_BASE_URL,
  RETIRED_BUILD_OVERRIDE_ENVIRONMENT_KEYS,
  STAGING_API_BASE_URL,
  normalizeApiBaseUrl,
} from "./plugin-build-options.mjs";

export const REQUIRED_PLUGIN_ARTIFACTS = ["manifest.json", "main.js", "styles.css"];

const INLINE_SOURCE_MAP_PATTERN = /[#@]\s*sourceMappingURL=data:/;
const CSS_BUILD_FAILURE_PATTERN = /\/\*\s*CSS build failed\s*\*\//i;
const PLUGIN_API_BASE_PATTERN = /https?:\/\/(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d+)?\/api\/plugin\b/gi;
const RETIRED_SYSTEMSCULPT_API_HOST = "https://api.systemsculpt.com";

const FORBIDDEN_SERVICE_IDENTITY_RULES = [
  { identity: "OpenRouter", pattern: /\bopenrouter\b|openrouter\.ai|@openrouter\//i },
  { identity: "AI SDK", pattern: /\bai[ _-]?sdk\b|@ai-sdk\//i },
  { identity: "Think runtime", pattern: /@cloudflare\/think\b|\bthink(?:agent|client|runtime|sdk)\b/i },
  {
    identity: "Pi runtime",
    pattern: /@(?:earendil-works|mariozechner)\/pi-(?:agent-core|ai|coding-agent)\b|\bpi-client-v\d+\b|["'`]pi["'`]/i,
  },
  {
    identity: "OpenAI",
    pattern: /\bopenai\b|openai(?:api|client|credential|key|model|provider|secret)|api\.openai\.com/i,
  },
  { identity: "Anthropic", pattern: /\banthropic\b|api\.anthropic\.com/i },
  { identity: "Google Gemini", pattern: /\bgemini\b|generativelanguage\.googleapis\.com/i },
];

const FORBIDDEN_SECRET_RULES = [
  { kind: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { kind: "OpenAI-compatible API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: "Stripe live secret", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { kind: "GitHub access token", pattern: /\b(?:gh[oprsu]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { kind: "npm access token", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { kind: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { kind: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  {
    kind: "literal credential assignment",
    pattern: /\b(?:apiKey|api_key|accessToken|access_token|clientSecret|client_secret|password)\b\s*[:=]\s*["'`][^\s"'`]{20,}["'`]/i,
  },
  { kind: "credential-bearing URL", pattern: /https?:\/\/[^\s/"'`:@]+:[^\s/"'`@]+@/i },
];
function bundleFragmentRules(message, fragments) {
  return fragments.map((fragment) => ({ fragment, message }));
}

export const THIN_CLIENT_FORBIDDEN_BUNDLE_FRAGMENTS = [
  ...bundleFragmentRules(
    "main.js still bundles retired client chat authority.",
    [
      "ManagedAgentController",
      "ManagedChatRuntimeAdapter",
      "ManagedChatSessionBudget",
      "ManagedChatInputLimits",
      "AcceptedChatRequestSnapshot",
      "ChatRequestPreparationService",
      "OrderedMessageStream",
      "ManagedToolContinuationBudget",
      "inspectManagedToolContinuationBudget",
      "DEFAULT_MAX_CONTINUATION_ROUNDS",
      "maxContinuationRounds",
      "max_tool_continuation_depth",
      "MAX_SAME_KEY_RETRIES",
      "MAX_DISCONNECT_RECOVERY_REQUESTS",
      "DISCONNECT_RETRY_BASE_DELAY_MS",
    ],
  ),
  ...bundleFragmentRules(
    "main.js still bundles retired client model or provider authority.",
    [
      "ModelManagementService",
      "UnifiedModelService",
      "PiTextCatalog",
      "RemoteProviderCatalog",
      "createPiModelRegistry",
      "ChatModelSelectionController",
      "LocalPiStreamExecutor",
      "PiLocalAgentExecutor",
      "PiTextRuntime",
      "PiSdkSessionCore",
    ],
  ),
  ...bundleFragmentRules(
    "main.js still bundles a retired client SDK or UI runtime.",
    [
      "node_modules/agents/",
      "node_modules/ai/",
      "node_modules/@ai-sdk/",
      "node_modules/react/",
      "node_modules/react-dom/",
      "WebSocketChatTransport",
      "cf_agent_",
      "Invalid hook call",
    ],
  ),
  {
    fragment: "Agent stopped",
    message: "main.js still contains the retired stop-response copy.",
  },
  {
    fragment: "connection.ticket",
    message: "main.js still exposes an internal connection ticket field.",
  },
];

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
  ...THIN_CLIENT_FORBIDDEN_BUNDLE_FRAGMENTS,
];

const LOOPBACK_SERVICE_URL_PATTERN =
  /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s"'`\\)<>\]]*)?/gi;
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

function inspectArtifactPath(filePath) {
  try {
    const stats = fs.lstatSync(filePath);
    return {
      path: filePath,
      exists: true,
      sizeBytes: stats.isFile() ? stats.size : null,
      isRegularFile: stats.isFile(),
      isSymbolicLink: stats.isSymbolicLink(),
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      path: filePath,
      exists: false,
      sizeBytes: null,
      isRegularFile: false,
      isSymbolicLink: false,
    };
  }
}

function artifactPathProblem(fileName, file) {
  if (!file.exists || file.isRegularFile) return null;
  return `${fileName} must be a regular file and must not be a symbolic link.`;
}

export function assertSafePluginArtifactPathsForBuild({
  root = process.cwd(),
} = {}) {
  const resolvedRoot = path.resolve(root);
  const files = Object.fromEntries(
    REQUIRED_PLUGIN_ARTIFACTS.map((fileName) => [
      fileName,
      inspectArtifactPath(path.join(resolvedRoot, fileName)),
    ]),
  );
  if (!files["manifest.json"].exists) {
    throw new Error("manifest.json must exist before building plugin artifacts.");
  }
  const problems = REQUIRED_PLUGIN_ARTIFACTS
    .map((fileName) => artifactPathProblem(fileName, files[fileName]))
    .filter(Boolean);
  if (problems.length > 0) {
    throw new Error(problems.join(" "));
  }
  return files;
}

/**
 * Marker embedded by src/testing/driver/protocol.ts. Kept as a literal here
 * because build scripts cannot import TypeScript sources.
 */
export const TEST_DRIVER_BUNDLE_MARKER = "SystemSculptTestDriver/v1";

export function inspectPluginArtifacts({
  root = process.cwd(),
  expectedApiBaseUrl = CANONICAL_API_BASE_URL,
  forbiddenApiBaseUrls = [],
  allowedLoopbackApiBaseUrls = [],
  expectTestDriver = null,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const normalizedExpectedApiBaseUrl = normalizeApiBaseUrl(expectedApiBaseUrl);
  const normalizedForbiddenApiBaseUrls = Array.from(
    new Set(forbiddenApiBaseUrls.map((value) => normalizeApiBaseUrl(value))),
  ).filter((value) => value !== normalizedExpectedApiBaseUrl);
  const normalizedAllowedLoopbackApiBaseUrls = new Set(
    allowedLoopbackApiBaseUrls.map((value) => normalizeApiBaseUrl(value)),
  );
  const files = Object.fromEntries(
    REQUIRED_PLUGIN_ARTIFACTS.map((fileName) => [
      fileName,
      inspectArtifactPath(path.join(resolvedRoot, fileName)),
    ]),
  );

  const missingFiles = REQUIRED_PLUGIN_ARTIFACTS.filter((fileName) => !files[fileName].exists);
  const problems = REQUIRED_PLUGIN_ARTIFACTS
    .map((fileName) => artifactPathProblem(fileName, files[fileName]))
    .filter(Boolean);

  if (missingFiles.length > 0) {
    problems.push(`Missing plugin artifacts: ${missingFiles.join(", ")}`);
  }

  const manifestFile = files["manifest.json"];
  let manifestMobileCompatible = false;
  if (manifestFile.isRegularFile) {
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
    expectedApiBaseUrl: normalizedExpectedApiBaseUrl,
    hasExpectedApiBase: false,
    pluginApiBases: [],
    unexpectedPluginApiBases: [],
    forbiddenApiBases: [],
    hasRetiredApiHost: false,
    loopbackApiBases: [],
    forbiddenClientFragments: [],
    upstreamRuntimeIdentities: [],
    forbiddenSecrets: [],
    nodeBuiltinRequires: [],
    mobileUnsafeNodeRequires: [],
    hasTestDriver: false,
  };

  if (mainFile.isRegularFile) {
    const bundleText = fs.readFileSync(mainFile.path, "utf8");
    mainBundle.hasInlineSourceMap = INLINE_SOURCE_MAP_PATTERN.test(bundleText);
    if (mainBundle.hasInlineSourceMap) {
      problems.push(
        `main.js still contains an inline source map (${mainBundle.formattedSize}); plugin sync must use a production build.`
      );
    }

    mainBundle.hasCanonicalApiBase = bundleText.includes(CANONICAL_API_BASE_URL);
    mainBundle.pluginApiBases = Array.from(
      new Set((bundleText.match(PLUGIN_API_BASE_PATTERN) || []).map(normalizeApiBaseUrl)),
    );
    mainBundle.hasExpectedApiBase = mainBundle.pluginApiBases.includes(normalizedExpectedApiBaseUrl);
    if (!mainBundle.hasExpectedApiBase) {
      const qualifier = normalizedExpectedApiBaseUrl === CANONICAL_API_BASE_URL
        ? "canonical"
        : "expected";
      problems.push(
        `main.js does not contain the ${qualifier} SystemSculpt API base ${normalizedExpectedApiBaseUrl}.`,
      );
    }
    mainBundle.unexpectedPluginApiBases = mainBundle.pluginApiBases.filter(
      (value) => value !== normalizedExpectedApiBaseUrl,
    );
    if (mainBundle.unexpectedPluginApiBases.length > 0) {
      problems.push(
        `main.js contains plugin API bases outside the selected build route: ${mainBundle.unexpectedPluginApiBases.join(", ")}.`,
      );
    }
    mainBundle.forbiddenApiBases = normalizedForbiddenApiBaseUrls.filter((value) =>
      mainBundle.pluginApiBases.includes(value)
    );
    if (mainBundle.forbiddenApiBases.length > 0) {
      problems.push(
        `main.js contains API bases forbidden for this build target: ${mainBundle.forbiddenApiBases.join(", ")}.`,
      );
    }

    mainBundle.hasRetiredApiHost = bundleText.includes(RETIRED_SYSTEMSCULPT_API_HOST);
    if (mainBundle.hasRetiredApiHost) {
      problems.push(`main.js contains the retired SystemSculpt API host ${RETIRED_SYSTEMSCULPT_API_HOST}.`);
    }

    mainBundle.loopbackApiBases = Array.from(
      new Set(bundleText.match(LOOPBACK_SERVICE_URL_PATTERN) || []),
    );
    const unexpectedLoopbackApiBases = mainBundle.loopbackApiBases.filter(
      (value) => !Array.from(normalizedAllowedLoopbackApiBaseUrls).some(
        (allowed) => value === allowed || value.startsWith(`${allowed}/`),
      ),
    );
    if (unexpectedLoopbackApiBases.length > 0) {
      problems.push(
        `main.js contains a loopback service URL: ${unexpectedLoopbackApiBases.join(", ")}.`,
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

    mainBundle.upstreamRuntimeIdentities = FORBIDDEN_SERVICE_IDENTITY_RULES
      .filter(({ pattern }) => pattern.test(bundleText))
      .map(({ identity }) => identity);
    if (mainBundle.upstreamRuntimeIdentities.length > 0) {
      problems.push(
        `main.js exposes upstream service or provider identities: ${mainBundle.upstreamRuntimeIdentities.join(", ")}.`,
      );
    }

    mainBundle.forbiddenSecrets = FORBIDDEN_SECRET_RULES
      .filter(({ pattern }) => pattern.test(bundleText))
      .map(({ kind }) => kind);
    if (mainBundle.forbiddenSecrets.length > 0) {
      problems.push(
        `main.js appears to contain embedded secrets: ${mainBundle.forbiddenSecrets.join(", ")}.`,
      );
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

    mainBundle.hasTestDriver = bundleText.includes(TEST_DRIVER_BUNDLE_MARKER);
    if (expectTestDriver === false && mainBundle.hasTestDriver) {
      problems.push(
        "main.js contains the E2E test driver; release artifacts must exclude it.",
      );
    }
    if (expectTestDriver === true && !mainBundle.hasTestDriver) {
      problems.push(
        "main.js is missing the E2E test driver expected in this development artifact.",
      );
    }
  }

  const stylesFile = files["styles.css"];
  const stylesBundle = {
    path: stylesFile.path,
    exists: stylesFile.exists,
    sizeBytes: stylesFile.sizeBytes,
    formattedSize: stylesFile.exists ? formatBytes(stylesFile.sizeBytes) : "missing",
    hasBuildFailureSentinel: false,
    isEffectivelyEmpty: false,
  };
  if (stylesFile.isRegularFile) {
    const stylesText = fs.readFileSync(stylesFile.path, "utf8");
    stylesBundle.hasBuildFailureSentinel = CSS_BUILD_FAILURE_PATTERN.test(stylesText);
    stylesBundle.isEffectivelyEmpty =
      stylesText.replace(/\/\*[\s\S]*?\*\//g, "").trim().length === 0;
    if (stylesBundle.hasBuildFailureSentinel) {
      problems.push("styles.css contains the CSS build failure sentinel.");
    }
    if (stylesBundle.isEffectivelyEmpty) {
      problems.push("styles.css contains no effective CSS.");
    }
  }

  return {
    root: resolvedRoot,
    files,
    missingFiles,
    manifestMobileCompatible,
    mainBundle,
    stylesBundle,
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
  const inspection = inspectPluginArtifacts({
    ...options,
    expectedApiBaseUrl: CANONICAL_API_BASE_URL,
    forbiddenApiBaseUrls: [STAGING_API_BASE_URL, LOCAL_AGENT_API_BASE_URL],
    allowedLoopbackApiBaseUrls: [],
    expectTestDriver: false,
  });
  if (!inspection.ok) {
    throw new Error(formatArtifactProblems(inspection));
  }
  return inspection;
}

export function assertStagingPluginArtifacts(options = {}) {
  const inspection = inspectPluginArtifacts({
    ...options,
    expectedApiBaseUrl: STAGING_API_BASE_URL,
    forbiddenApiBaseUrls: [CANONICAL_API_BASE_URL, LOCAL_AGENT_API_BASE_URL],
    allowedLoopbackApiBaseUrls: [],
    expectTestDriver: true,
  });
  if (!inspection.ok) {
    throw new Error(formatArtifactProblems(inspection));
  }
  return inspection;
}

export function assertLocalAgentPluginArtifacts(options = {}) {
  const inspection = inspectPluginArtifacts({
    ...options,
    expectedApiBaseUrl: LOCAL_AGENT_API_BASE_URL,
    forbiddenApiBaseUrls: [CANONICAL_API_BASE_URL, STAGING_API_BASE_URL],
    allowedLoopbackApiBaseUrls: [LOCAL_AGENT_API_BASE_URL],
    expectTestDriver: true,
  });
  if (!inspection.ok) {
    throw new Error(formatArtifactProblems(inspection));
  }
  return inspection;
}

function sanitizedBuildEnvironment(environment) {
  const sanitized = { ...environment };
  for (const key of RETIRED_BUILD_OVERRIDE_ENVIRONMENT_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

function buildPluginTarget({
  root,
  stdio,
  env,
  spawnSyncImpl,
  target,
  label,
  assertArtifacts,
}) {
  const resolvedRoot = path.resolve(root);
  assertSafePluginArtifactPathsForBuild({ root: resolvedRoot });
  const result = spawnSyncImpl(
    process.execPath,
    [path.join(resolvedRoot, "esbuild.config.mjs"), target],
    {
      cwd: resolvedRoot,
      env: sanitizedBuildEnvironment(env),
      stdio,
      encoding: "utf8",
    },
  );

  if (result?.error) throw result.error;
  if ((result?.status ?? 1) !== 0) {
    const output = [result?.stderr, result?.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${label} plugin build failed.${output ? `\n${output}` : ""}`);
  }
  return assertArtifacts({ root: resolvedRoot });
}

export function buildProductionPlugin({
  root = process.cwd(),
  stdio = "inherit",
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  return buildPluginTarget({
    root,
    stdio,
    env,
    spawnSyncImpl,
    target: "production",
    label: "Production",
    assertArtifacts: assertProductionPluginArtifacts,
  });
}

export function buildStagingPlugin({
  root = process.cwd(),
  stdio = "inherit",
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  return buildPluginTarget({
    root,
    stdio,
    env,
    spawnSyncImpl,
    target: "staging",
    label: "Staging",
    assertArtifacts: assertStagingPluginArtifacts,
  });
}

export function buildLocalAgentPlugin({
  root = process.cwd(),
  stdio = "inherit",
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  return buildPluginTarget({
    root,
    stdio,
    env,
    spawnSyncImpl,
    target: "local-agent",
    label: "Local agent",
    assertArtifacts: assertLocalAgentPluginArtifacts,
  });
}
