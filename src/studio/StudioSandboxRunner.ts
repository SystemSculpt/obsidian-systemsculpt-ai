import { desktopHost, hasNodeRuntime } from "../platform/desktopOnly";
import { StudioPermissionManager } from "./StudioPermissionManager";
import type { StudioCliExecutionRequest, StudioCliExecutionResult } from "./types";

const COMMON_CLI_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/opt/local/bin"];
const MAX_OUTPUT_BYTES = 1024 * 1024;

function mergeCliPath(rawPath: string, delimiter: string): string {
  const segments = rawPath.split(delimiter).map((segment) => segment.trim()).filter(Boolean);
  return Array.from(new Set([...segments, ...COMMON_CLI_PATHS])).join(delimiter);
}

/** Byte-bounded UTF-8 capture also bounds callbacks (including unterminated lines). */
function captureStream(limit: number, callback?: (chunk: string) => void) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let count = 0;
  let textBytes = 0;
  let value = "";
  let truncated = false;
  const appendText = (text: string): void => {
    const bytes = encoder.encode(text);
    if (bytes.byteLength > limit - textBytes) {
      truncated = true;
      text = new TextDecoder().decode(bytes.subarray(0, limit - textBytes), { stream: true });
    }
    textBytes += encoder.encode(text).byteLength;
    value += text;
    if (text) callback?.(text);
  };
  return {
    append(chunk: Uint8Array | string) {
      const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
      const remaining = Math.max(0, limit - count);
      if (bytes.byteLength > remaining) truncated = true;
      const accepted = bytes.subarray(0, remaining);
      count += accepted.byteLength;
      const text = decoder.decode(accepted, { stream: true });
      appendText(text);
    },
    finish() {
      // A cap in the middle of a UTF-8 codepoint must not add replacement bytes beyond the cap.
      const tail = truncated ? "" : decoder.decode();
      appendText(tail);
      return { value, truncated };
    },
  };
}

export class StudioSandboxRunner {
  constructor(private readonly permissions: StudioPermissionManager) {}

  async runCli(request: StudioCliExecutionRequest): Promise<StudioCliExecutionResult> {
    if (!hasNodeRuntime()) throw new Error("CLI execution requires Obsidian Desktop.");
    const command = String(request.command || "").trim();
    if (!command) throw new Error("CLI execution requires a command.");
    const cwd = String(request.cwd || "").trim();
    if (!cwd) throw new Error("CLI execution requires a working directory.");
    this.permissions.assertCliCommand(command, request.requireExactCommandGrant);
    this.permissions.assertFilesystemPath(cwd);
    const args = Array.isArray(request.args) ? request.args.map(String) : [];
    const timeoutMs = Math.max(100, Math.min(86_400_000, Math.floor(request.timeoutMs ?? 30_000)));
    const maxOutputBytes = Math.max(1024, Math.min(MAX_OUTPUT_BYTES, Math.floor(request.maxOutputBytes ?? 256 * 1024)));
    if (!Number.isFinite(timeoutMs) || !Number.isFinite(maxOutputBytes)) throw new Error("Invalid CLI execution limits.");
    if (new TextEncoder().encode(request.input || "").byteLength > MAX_OUTPUT_BYTES) throw new Error("CLI stdin exceeds the 1 MB limit.");
    const [childProcess, path] = await Promise.all([desktopHost.childProcess(), desktopHost.path()]);
    if (request.signal?.aborted) {
      const error = new Error("Process cancelled.");
      error.name = "AbortError";
      throw error;
    }

    return await new Promise<StudioCliExecutionResult>((resolve, reject) => {
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      const stdout = captureStream(maxOutputBytes, request.onStdout);
      const stderr = captureStream(maxOutputBytes, request.onStderr);
      const mergedEnv = { ...desktopHost.environment(), ...(request.env || {}) };
      mergedEnv.PATH = mergeCliPath(String(mergedEnv.PATH || ""), path.delimiter);
      const processGroup = desktopHost.supportsProcessGroups();
      const child = childProcess.spawn(command, args, { cwd, env: mergedEnv, shell: false, detached: processGroup });
      const kill = (): void => {
        // POSIX groups prevent helper subprocesses continuing a publish after cancellation.
        if (processGroup && child.pid) {
          try { desktopHost.killProcessGroup(child.pid); return; } catch { /* fall back if already exited */ }
        }
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      };
      const onAbort = (): void => { cancelled = true; kill(); };
      const timeout = window.setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      const cleanup = (): void => {
        window.clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        kill();
        reject(error);
      };
      child.stdout.on("data", (chunk: Uint8Array | string) => { if (!settled) stdout.append(chunk); });
      child.stderr.on("data", (chunk: Uint8Array | string) => { if (!settled) stderr.append(chunk); });
      child.on("error", fail);
      // Programs may legitimately ignore stdin; EPIPE must not become an uncaught host error.
      child.stdin?.on?.("error", (error: Error & { code?: string }) => { if (error.code !== "EPIPE") fail(error); });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        const out = stdout.finish();
        const err = stderr.finish();
        resolve({
          exitCode: typeof code === "number" ? code : 1,
          stdout: out.value,
          stderr: err.value,
          timedOut,
          ...(cancelled ? { cancelled: true } : {}),
          ...(out.truncated ? { stdoutTruncated: true } : {}),
          ...(err.truncated ? { stderrTruncated: true } : {}),
        });
      });
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.signal?.aborted) onAbort();
      try { child.stdin?.end(request.input); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}
