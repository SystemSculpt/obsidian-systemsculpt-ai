import { Platform } from "obsidian";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type SystemSculptPlugin from "../../main";
import {
  STUDIO_PI_COMMON_CLI_PATHS,
  appendStudioPiOutput,
  isLikelyMissingStudioPiExecutableError,
  mergeStudioPiCliPath,
} from "../../studio/piAuth/StudioPiProcessUtils";
import {
  buildSystemSculptPiProviderEnv,
  ensureSystemSculptPiProviderExtension,
} from "./PiSystemSculptProvider";
import { buildPiNodeChildEnv, resolvePiNodeCommandCandidates } from "./PiNodeRuntime";
import { ensureBundledPiRuntime } from "./PiRuntimeBootstrap";
import { resolvePiPackageRoot } from "./PiSdk";

export type PiResolvedRuntime = {
  command: string;
  argsPrefix: string[];
  source: "local-package" | "path-override" | "global-cli";
  label: string;
  env?: Record<string, string>;
};

export type PiCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  runtime: PiResolvedRuntime;
};

type PiSpawnBaseOptions = {
  plugin: SystemSculptPlugin;
  args: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
};

export type PiRunCommandOptions = PiSpawnBaseOptions & {
  timeoutMs: number;
};

export type PiStartProcessOptions = PiSpawnBaseOptions;

function resolvePiCliScriptFromPackage(): string | null {
  const explicitScript = String(process.env.SYSTEMSCULPT_PI_CLI_SCRIPT || "").trim();
  if (explicitScript && existsSync(explicitScript)) {
    return explicitScript;
  }

  try {
    const candidate = join(resolvePiPackageRoot(), "dist", "cli.js");
    if (existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // Fall back to absolute CLI candidates below if the local package is unavailable.
  }

  return null;
}

function resolvePiAbsoluteCandidates(): string[] {
  const explicitPath = String(process.env.SYSTEMSCULPT_PI_CLI_PATH || "").trim();
  const candidates = explicitPath ? [explicitPath] : [];

  for (const basePath of STUDIO_PI_COMMON_CLI_PATHS) {
    const candidate = `${basePath}/pi`;
    try {
      if (existsSync(candidate)) {
        candidates.push(candidate);
      }
    } catch {
      // Ignore stat failures and keep scanning.
    }
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

export function resolvePiCommandCwd(plugin: SystemSculptPlugin): string {
  const adapter = plugin.app?.vault?.adapter as {
    getBasePath?: () => string;
    basePath?: string;
  };
  const fromGetter =
    typeof adapter?.getBasePath === "function" ? String(adapter.getBasePath() || "").trim() : "";
  if (fromGetter) {
    return fromGetter;
  }

  const fromBasePath = String(adapter?.basePath || "").trim();
  if (fromBasePath) {
    return fromBasePath;
  }

  if (typeof process?.cwd === "function") {
    try {
      const cwd = String(process.cwd() || "").trim();
      if (cwd) {
        return cwd;
      }
    } catch {
      // Fall through to root below.
    }
  }

  return "/";
}

export function createPiCommandEnv(extraEnv?: Record<string, string | undefined>): Record<string, string> {
  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  mergedEnv.PATH = mergeStudioPiCliPath(String(mergedEnv.PATH || ""));

  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (typeof value === "string") {
      mergedEnv[key] = value;
    }
  }

  return mergedEnv;
}

export function resolvePiRuntimes(baseEnv?: Record<string, string>): PiResolvedRuntime[] {
  const runtimes: PiResolvedRuntime[] = [];
  const seen = new Set<string>();

  const addRuntime = (runtime: PiResolvedRuntime | null) => {
    if (!runtime) {
      return;
    }
    const key = `${runtime.command}::${runtime.argsPrefix.join("\u0000")}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    runtimes.push(runtime);
  };

  const cliScript = resolvePiCliScriptFromPackage();
  if (cliScript) {
    const nodeEnv = { ...(baseEnv || process.env) } as NodeJS.ProcessEnv;
    for (const nodeCommand of resolvePiNodeCommandCandidates({ baseEnv: nodeEnv })) {
      addRuntime({
        command: nodeCommand,
        argsPrefix: [cliScript],
        source: "local-package",
        label: `${nodeCommand} ${cliScript}`,
        env: buildPiNodeChildEnv({
          baseEnv: nodeEnv,
          runtimeCommand: nodeCommand,
        }) as Record<string, string>,
      });
    }
  }

  for (const candidate of resolvePiAbsoluteCandidates()) {
    addRuntime({
      command: candidate,
      argsPrefix: [],
      source: candidate === process.env.SYSTEMSCULPT_PI_CLI_PATH ? "path-override" : "global-cli",
      label: candidate,
    });
  }

  addRuntime({
    command: "pi",
    argsPrefix: [],
    source: "global-cli",
    label: "pi",
  });

  return runtimes;
}

function isMissingPiBinary(error: unknown): boolean {
  return isLikelyMissingStudioPiExecutableError(error, ["pi", "node"]);
}

async function spawnProcessForRuntime(
  runtime: PiResolvedRuntime,
  options: {
    args: string[];
    cwd: string;
    env: Record<string, string>;
    timeoutMs?: number;
  }
): Promise<PiCommandResult> {
  return await new Promise<PiCommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(runtime.command, [...runtime.argsPrefix, ...options.args], {
      cwd: options.cwd,
      env: runtime.env || options.env,
      shell: false,
    });

    try {
      child.stdin?.end();
    } catch {
      // Ignore stdin shutdown failures.
    }

    const timeout =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill("SIGKILL");
            } catch {
              // Ignore kill failures.
            }
          }, Math.max(100, Math.floor(options.timeoutMs)))
        : null;

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendStudioPiOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendStudioPiOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        exitCode: typeof code === "number" ? code : 1,
        stdout,
        stderr,
        timedOut,
        runtime,
      });
    });
  });
}

export async function runPiCommandWithResolvedRuntime(
  options: PiRunCommandOptions
): Promise<PiCommandResult> {
  if (!Platform.isDesktopApp) {
    throw new Error("Pi desktop execution is only available on desktop.");
  }

  const cwd = String(options.cwd || "").trim() || resolvePiCommandCwd(options.plugin);
  const extensionPath = await ensureSystemSculptPiProviderExtension(options.plugin);
  const env = createPiCommandEnv({
    ...buildSystemSculptPiProviderEnv(options.plugin),
    ...(options.env || {}),
  });
  await ensureBundledPiRuntime({ plugin: options.plugin });
  const runtimes = resolvePiRuntimes(env);
  let lastMissingBinaryError: unknown = null;

  for (const runtime of runtimes) {
    try {
      return await spawnProcessForRuntime(runtime, {
        args: ["--extension", extensionPath, ...options.args],
        cwd,
        env,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      if (isMissingPiBinary(error)) {
        lastMissingBinaryError = error;
        continue;
      }
      throw error;
    }
  }

  if (lastMissingBinaryError) {
    throw lastMissingBinaryError;
  }

  throw new Error("Unable to resolve a Pi runtime on this machine.");
}

export async function startPiProcess(
  options: PiStartProcessOptions
): Promise<{ child: ChildProcessWithoutNullStreams; runtime: PiResolvedRuntime }> {
  if (!Platform.isDesktopApp) {
    throw new Error("Pi desktop execution is only available on desktop.");
  }

  const cwd = String(options.cwd || "").trim() || resolvePiCommandCwd(options.plugin);
  const extensionPath = await ensureSystemSculptPiProviderExtension(options.plugin);
  const env = createPiCommandEnv({
    ...buildSystemSculptPiProviderEnv(options.plugin),
    ...(options.env || {}),
  });
  await ensureBundledPiRuntime({ plugin: options.plugin });
  const runtimes = resolvePiRuntimes(env);
  let lastMissingBinaryError: unknown = null;

  for (const runtime of runtimes) {
    try {
      const child = await new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
        const spawned = spawn(runtime.command, [...runtime.argsPrefix, "--extension", extensionPath, ...options.args], {
          cwd,
          env: runtime.env || env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        }) as ChildProcessWithoutNullStreams;

        const cleanup = () => {
          spawned.removeListener("spawn", onSpawn);
          spawned.removeListener("error", onError);
        };

        const onSpawn = () => {
          cleanup();
          resolve(spawned);
        };

        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };

        spawned.once("spawn", onSpawn);
        spawned.once("error", onError);
      });

      return {
        child,
        runtime,
      };
    } catch (error) {
      if (isMissingPiBinary(error)) {
        lastMissingBinaryError = error;
        continue;
      }
      throw error;
    }
  }

  if (lastMissingBinaryError) {
    throw lastMissingBinaryError;
  }

  throw new Error("Unable to resolve a Pi runtime on this machine.");
}
