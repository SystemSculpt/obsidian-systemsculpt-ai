import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

const COMMON_NODE_PATHS = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "/bin/node"];

export function looksLikeNodeRuntimePath(commandPath: string): boolean {
  const normalized = String(commandPath || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const basename = normalized.split(/[\\/]/).pop() || normalized;
  return basename === "node" || basename === "node.exe" || basename.startsWith("node-");
}

export function buildPiNodeChildEnv(options?: {
  baseEnv?: NodeJS.ProcessEnv;
  runtimeVersions?: NodeJS.ProcessVersions | Record<string, string | undefined>;
  runtimeCommand?: string;
  execPath?: string;
}): NodeJS.ProcessEnv {
  const env = { ...(options?.baseEnv || process.env) } as NodeJS.ProcessEnv;
  const runtimeVersions = options?.runtimeVersions || process.versions;
  const electronVersion = String((runtimeVersions as Record<string, string | undefined>).electron || "").trim();
  const runtimeCommand = String(options?.runtimeCommand || "").trim();
  const execPath = String(options?.execPath || process.execPath || "").trim();
  if (electronVersion && runtimeCommand && runtimeCommand === execPath && !looksLikeNodeRuntimePath(runtimeCommand)) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

export function resolvePiNodeCommandCandidates(options?: {
  execPath?: string;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runtimeVersions?: NodeJS.ProcessVersions | Record<string, string | undefined>;
  fileExists?: (path: string) => boolean;
  extraCandidates?: string[];
}): string[] {
  const execPath = String(options?.execPath || process.execPath || "").trim();
  const baseEnv = { ...(options?.baseEnv || process.env) } as NodeJS.ProcessEnv;
  const platform = options?.platform || process.platform;
  const runtimeVersions = options?.runtimeVersions || process.versions;
  const electronVersion = String((runtimeVersions as Record<string, string | undefined>).electron || "").trim();
  const fileExists = options?.fileExists || existsSync;
  const commonCandidates = platform === "win32"
    ? ["node.exe", "node"]
    : [...COMMON_NODE_PATHS, "node"];
  const envNodeCandidates = [
    String(baseEnv.SYSTEMSCULPT_PI_OAUTH_NODE_PATH || "").trim(),
    String(baseEnv.SYSTEMSCULPT_PI_NODE_PATH || "").trim(),
    String(baseEnv.SYSTEMSCULPT_NODE_PATH || "").trim(),
    String(baseEnv.NODE || "").trim(),
    String(baseEnv.npm_node_execpath || "").trim(),
  ];
  const extraCandidates = Array.isArray(options?.extraCandidates) ? options?.extraCandidates : [];
  const shouldPreferExecPath = !electronVersion || looksLikeNodeRuntimePath(execPath);
  const preferredCandidates = shouldPreferExecPath
    ? [...envNodeCandidates, execPath, ...extraCandidates, ...commonCandidates]
    : [...envNodeCandidates, ...extraCandidates, ...commonCandidates, execPath];

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const candidate of preferredCandidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    if (isAbsolute(normalized) && !fileExists(normalized)) {
      continue;
    }
    seen.add(normalized);
    resolved.push(normalized);
  }

  return resolved;
}
