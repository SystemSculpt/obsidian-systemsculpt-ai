import { Platform } from "obsidian";
import { spawn } from "node:child_process";
import { StudioPermissionManager } from "./StudioPermissionManager";
import type { StudioCliExecutionRequest, StudioCliExecutionResult } from "./types";

const COMMON_CLI_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/opt/local/bin"];

function mergeCliPath(rawPath: string): string {
  const segments = rawPath
    .split(":")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const seen = new Set(segments);
  for (const segment of COMMON_CLI_PATHS) {
    if (!seen.has(segment)) {
      segments.push(segment);
      seen.add(segment);
    }
  }
  return segments.join(":");
}

export class StudioSandboxRunner {
  constructor(private readonly permissions: StudioPermissionManager) {}

  async runCli(request: StudioCliExecutionRequest): Promise<StudioCliExecutionResult> {
    if (!Platform.isDesktopApp) {
      throw new Error("CLI execution is desktop-only.");
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

    return await new Promise<StudioCliExecutionResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const mergedEnv: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...(request.env || {}),
      };
      mergedEnv.PATH = mergeCliPath(String(mergedEnv.PATH || ""));

      const child = spawn(command, args, {
        cwd,
        env: mergedEnv,
        shell: false,
      });

      const truncate = (value: string): string => {
        if (value.length <= maxOutputBytes) {
          return value;
        }
        return value.slice(0, maxOutputBytes);
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {}
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout = truncate(stdout + chunk.toString());
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr = truncate(stderr + chunk.toString());
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
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
