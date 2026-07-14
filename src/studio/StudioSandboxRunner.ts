import { desktopHost, hasNodeRuntime } from "../platform/desktopOnly";
import { StudioPermissionManager } from "./StudioPermissionManager";
import type { StudioCliExecutionRequest, StudioCliExecutionResult } from "./types";

const COMMON_CLI_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/opt/local/bin"];

function mergeCliPath(rawPath: string, delimiter: string): string {
  const segments = rawPath
    .split(delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const seen = new Set(segments);
  for (const segment of COMMON_CLI_PATHS) {
    if (!seen.has(segment)) {
      segments.push(segment);
      seen.add(segment);
    }
  }
  return segments.join(delimiter);
}

export class StudioSandboxRunner {
  constructor(private readonly permissions: StudioPermissionManager) {}

  async runCli(request: StudioCliExecutionRequest): Promise<StudioCliExecutionResult> {
    if (!hasNodeRuntime()) {
      throw new Error("CLI execution requires Obsidian Desktop.");
    }

    const command = String(request.command || "").trim();
    if (!command) {
      throw new Error("CLI execution requires a command.");
    }

    const cwd = String(request.cwd || "").trim();
    if (!cwd) {
      throw new Error("CLI execution requires a working directory.");
    }

    this.permissions.assertCliCommand(command);
    this.permissions.assertFilesystemPath(cwd);

    const args = Array.isArray(request.args) ? request.args.map((value) => String(value)) : [];
    const timeoutMs = Math.max(100, Math.floor(request.timeoutMs ?? 30_000));
    const maxOutputBytes = Math.max(1024, Math.floor(request.maxOutputBytes ?? 256 * 1024));
    const childProcess = desktopHost.childProcess();
    const path = desktopHost.path();

    return await new Promise<StudioCliExecutionResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const mergedEnv: Record<string, string> = {
        ...(desktopHost.environment() as Record<string, string>),
        ...(request.env || {}),
      };
      mergedEnv.PATH = mergeCliPath(String(mergedEnv.PATH || ""), path.delimiter);

      const child = childProcess.spawn(command, args, {
        cwd,
        env: mergedEnv,
        shell: false,
      });
      // runCli is non-interactive; close stdin so adapters that probe stdin can continue immediately.
      try {
        child.stdin?.end();
      } catch {}

      const truncate = (value: string): string => {
        if (value.length <= maxOutputBytes) {
          return value;
        }
        return value.slice(0, maxOutputBytes);
      };

      const timeout = window.setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {}
      }, timeoutMs);

      child.stdout.on("data", (chunk: Uint8Array | string) => {
        stdout = truncate(stdout + chunk.toString());
      });

      child.stderr.on("data", (chunk: Uint8Array | string) => {
        stderr = truncate(stderr + chunk.toString());
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(error);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve({
          exitCode: typeof code === "number" ? code : 1,
          stdout,
          stderr,
          timedOut,
        });
      });
    });
  }
}
