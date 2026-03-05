import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SidecarStatusPayload = {
  state: string;
  socketPath: string;
  sessionCount: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveIntegrationSocketPath(key: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\systemsculpt-studio-terminal-${key}`;
  }
  return `/tmp/systemsculpt-studio-terminal-${key}.sock`;
}

function createStatusRequestMessage(): string {
  return `${JSON.stringify({ id: 1, type: "status", payload: {} })}\n`;
}

function requestStatusOnce(socketPath: string, timeoutMs: number): Promise<SidecarStatusPayload> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let buffer = "";

    const finishReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.destroy();
      } catch {
        // Best effort cleanup.
      }
      reject(error);
    };

    const timeout = setTimeout(() => {
      finishReject(new Error(`Timed out waiting for sidecar status on ${socketPath}`));
    }, timeoutMs);

    socket.once("connect", () => {
      try {
        socket.write(createStatusRequestMessage());
      } catch (error) {
        clearTimeout(timeout);
        finishReject(error instanceof Error ? error : new Error(String(error || "Socket write failed")));
      }
    });

    socket.on("data", (chunk) => {
      if (settled) {
        return;
      }
      buffer += String(chunk || "");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) {
          continue;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed.type !== "response" || Number(parsed.id) !== 1 || parsed.ok !== true) {
          continue;
        }
        const result = parsed.result && typeof parsed.result === "object" ? (parsed.result as Record<string, unknown>) : {};
        const status = result.status && typeof result.status === "object" ? (result.status as Record<string, unknown>) : {};
        settled = true;
        clearTimeout(timeout);
        socket.end();
        resolve({
          state: String(status.state || ""),
          socketPath: String(status.socketPath || ""),
          sessionCount: Number(status.sessionCount || 0),
        });
        return;
      }
    });

    socket.once("error", (error) => {
      clearTimeout(timeout);
      finishReject(error instanceof Error ? error : new Error(String(error || "Socket connection failed")));
    });
  });
}

async function waitForStatus(socketPath: string, deadlineMs: number): Promise<SidecarStatusPayload> {
  const start = Date.now();
  let lastError: Error | null = null;
  while (Date.now() - start < deadlineMs) {
    try {
      return await requestStatusOnce(socketPath, 1_200);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error || "Sidecar status request failed"));
      await sleep(120);
    }
  }
  throw lastError || new Error(`Terminal sidecar never responded on ${socketPath}`);
}

async function stopSidecar(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.killed) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Best effort shutdown.
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore hard-kill failures.
      }
      resolve();
    }, 3_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("studio-terminal-sidecar.cjs integration", () => {
  jest.setTimeout(30_000);

  it("boots sidecar runtime and responds to status requests", async () => {
    const key = `itest${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const socketPath = resolveIntegrationSocketPath(key);
    const statePath = join(tmpdir(), "systemsculpt-studio-terminal", `${key}.json`);
    const pluginInstallDir = process.cwd();
    const sidecarScriptPath = join(pluginInstallDir, "studio-terminal-sidecar.cjs");
    await access(sidecarScriptPath);

    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];
    const child = spawn(
      process.execPath,
      [
        sidecarScriptPath,
        "--socket",
        socketPath,
        "--state",
        statePath,
        "--pluginInstallDir",
        pluginInstallDir,
        "--vaultKey",
        key,
        "--timeoutMinutes",
        "15",
      ],
      {
        cwd: pluginInstallDir,
        env: process.env,
        stdio: "pipe",
        shell: false,
        windowsHide: true,
      }
    );

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""), "utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""), "utf8"));
    });

    try {
      const status = await waitForStatus(socketPath, 10_000);
      expect(status.state).toBe("connected");
      expect(status.socketPath).toBe(socketPath);
      expect(status.sessionCount).toBe(0);
    } catch (error) {
      const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8").trim();
      let stateContents = "";
      try {
        stateContents = (await readFile(statePath, "utf8")).trim();
      } catch {
        stateContents = "";
      }
      throw new Error(
        [
          `Sidecar integration test failed: ${error instanceof Error ? error.message : String(error)}`,
          stderrText ? `stderr: ${stderrText}` : "",
          stdoutText ? `stdout: ${stdoutText}` : "",
          stateContents ? `state: ${stateContents}` : "state: (missing)",
        ]
          .filter(Boolean)
          .join("\n")
      );
    } finally {
      await stopSidecar(child);
      try {
        await rm(statePath, { force: true });
      } catch {
        // Best effort cleanup.
      }
      if (process.platform !== "win32") {
        try {
          await rm(socketPath, { force: true });
        } catch {
          // Best effort cleanup.
        }
      }
    }
  });
});
