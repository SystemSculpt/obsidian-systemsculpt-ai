import { Platform } from "obsidian";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePtyTerminalBackend } from "../terminal/NodePtyTerminalBackend";
import { StudioTerminalSessionManager } from "../StudioTerminalSessionManager";
import { resolveInteractiveShellArgs } from "../terminal/StudioTerminalShell";

type ExitListener = (event: { exitCode: number | null; signal?: NodeJS.Signals | null }) => void;
type DataListener = (data: string) => void;

class TestTerminalProcess {
  readonly writes: string[] = [];
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private killed = false;

  write(data: string): void {
    this.writes.push(String(data || ""));
  }

  resize(): void {
    // no-op
  }

  kill(): void {
    if (this.killed) {
      return;
    }
    this.killed = true;
    this.emitExit(0, null);
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(exitCode: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode, signal });
    }
  }
}

describe("StudioTerminalSessionManager", () => {
  const originalPlatform = { ...Platform };

  beforeEach(() => {
    Object.assign(Platform, {
      ...originalPlatform,
      isDesktopApp: true,
    });
  });

  afterEach(() => {
    Object.assign(Platform, originalPlatform);
  });

  it("loads node-pty through runtime require when using the node-pty backend", async () => {
    const logger = {
      warn: jest.fn(),
    };
    const terminalProcess = new TestTerminalProcess();
    const spawnMock = jest.fn(() => terminalProcess as any);
    const pluginRoot = join(tmpdir(), `systemsculpt-terminal-test-${Date.now()}`);
    const nodePtyPath = join(pluginRoot, "node_modules", "node-pty");
    const prebuildPath = join(nodePtyPath, "prebuilds", `${process.platform}-${process.arch}`);
    mkdirSync(join(nodePtyPath, "lib"), { recursive: true });
    mkdirSync(prebuildPath, { recursive: true });
    writeFileSync(join(nodePtyPath, "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0" }), "utf8");
    writeFileSync(join(nodePtyPath, "lib", "index.js"), "module.exports = {};\n", "utf8");
    writeFileSync(join(prebuildPath, "pty.node"), "native", "utf8");
    if (process.platform !== "win32") {
      writeFileSync(join(prebuildPath, "spawn-helper"), "#!/bin/sh\necho helper\n", "utf8");
      chmodSync(join(prebuildPath, "spawn-helper"), 0o755);
    }
    const originalRequire = (globalThis as { require?: unknown }).require;
    const requireMock = jest.fn((id: string) => {
      if (id === nodePtyPath) {
        return {
          spawn: spawnMock,
        };
      }
      if (typeof originalRequire === "function") {
        return (originalRequire as (specifier: string) => unknown)(id);
      }
      throw new Error(`Unexpected module request: ${id}`);
    });

    (globalThis as { require?: unknown }).require = requireMock;
    try {
      const plugin = {
        app: {
          vault: {
            configDir: ".obsidian",
            adapter: {
              basePath: "",
            },
          },
        },
        manifest: {
          id: "systemsculpt-ai",
          dir: pluginRoot,
        },
        getLogger: () => logger,
      } as any;
      const manager = new StudioTerminalSessionManager(plugin, {
        backend: new NodePtyTerminalBackend(plugin),
      });

      const snapshot = await manager.ensureSession({
        projectPath: "SystemSculpt/Studio/RequireBackend.systemsculpt",
        nodeId: "terminal_node_require",
        cwd: globalThis.process.cwd(),
        shellProfile: "bash",
        cols: 120,
        rows: 32,
      });

      expect(snapshot.status).toBe("running");
      expect(requireMock).toHaveBeenCalledWith(nodePtyPath);
      expect(spawnMock).toHaveBeenCalled();

      await manager.stopSession({
        projectPath: "SystemSculpt/Studio/RequireBackend.systemsculpt",
        nodeId: "terminal_node_require",
      });
      await manager.dispose();
    } finally {
      (globalThis as { require?: unknown }).require = originalRequire;
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it("starts a session and forwards input/output", async () => {
    const logger = {
      warn: jest.fn(),
    };
    const terminalProcess = new TestTerminalProcess();
    const backend = {
      spawn: jest.fn(async () => terminalProcess as any),
    };
    const manager = new StudioTerminalSessionManager(
      {
        getLogger: () => logger,
      } as any,
      {
        backend: backend as any,
      }
    );

    const events: Array<{ type: string; data?: string }> = [];
    const unsubscribe = manager.subscribe(
      { projectPath: "SystemSculpt/Studio/Test.systemsculpt", nodeId: "terminal_node" },
      (event) => {
        if (event.type === "data") {
          events.push({ type: event.type, data: event.data });
          return;
        }
        events.push({ type: event.type });
      }
    );

    const snapshot = await manager.ensureSession({
      projectPath: "SystemSculpt/Studio/Test.systemsculpt",
      nodeId: "terminal_node",
      cwd: globalThis.process.cwd(),
      shellProfile: "bash",
      cols: 120,
      rows: 32,
      scrollback: 1_000,
    });

    expect(snapshot.status).toBe("running");
    expect(snapshot.shellCommand).toBeTruthy();
    const spawnOptions = backend.spawn.mock.calls[0]?.[0];
    expect(spawnOptions?.env?.SYSTEMSCULPT_STUDIO_TERMINAL).toBe("1");
    expect(spawnOptions?.env?.POWERLEVEL9K_INSTANT_PROMPT).toBe("off");
    expect(spawnOptions?.env?.TERM_PROGRAM).toBe("SystemSculpt Studio");

    manager.writeInput({
      projectPath: "SystemSculpt/Studio/Test.systemsculpt",
      nodeId: "terminal_node",
      data: "echo test\n",
    });
    expect(terminalProcess.writes).toContain("echo test\n");

    terminalProcess.emitData("hello from shell\n");
    const nextSnapshot = manager.getSnapshot({
      projectPath: "SystemSculpt/Studio/Test.systemsculpt",
      nodeId: "terminal_node",
    });
    expect(nextSnapshot?.history).toContain("hello from shell");
    expect(events.some((event) => event.type === "data" && event.data?.includes("hello from shell"))).toBe(true);

    await manager.stopSession({
      projectPath: "SystemSculpt/Studio/Test.systemsculpt",
      nodeId: "terminal_node",
    });
    unsubscribe();
    await manager.dispose();
  });

  it("spawns zsh as an interactive login shell with prompt spacing disabled", async () => {
    const logger = {
      warn: jest.fn(),
    };
    const terminalProcess = new TestTerminalProcess();
    const backend = {
      spawn: jest.fn(async () => terminalProcess as any),
    };
    const manager = new StudioTerminalSessionManager(
      {
        getLogger: () => logger,
      } as any,
      {
        backend: backend as any,
      }
    );

    const snapshot = await manager.ensureSession({
      projectPath: "SystemSculpt/Studio/ZshPrompt.systemsculpt",
      nodeId: "terminal_node_zsh_prompt",
      cwd: globalThis.process.cwd(),
      shellProfile: "zsh",
      cols: 120,
      rows: 32,
    });

    expect(snapshot.status).toBe("running");
    const spawnOptions = backend.spawn.mock.calls[0]?.[0];
    expect(spawnOptions?.command).toBe("zsh");
    expect(spawnOptions?.args).toEqual(["-i", "-l", "-o", "no_prompt_sp"]);

    await manager.stopSession({
      projectPath: "SystemSculpt/Studio/ZshPrompt.systemsculpt",
      nodeId: "terminal_node_zsh_prompt",
    });
    await manager.dispose();
  });

  it("resolves interactive shell args for POSIX login parity while keeping PowerShell behavior", () => {
    expect(resolveInteractiveShellArgs("zsh")).toEqual(["-i", "-l", "-o", "no_prompt_sp"]);
    expect(resolveInteractiveShellArgs("bash")).toEqual(["-i", "-l"]);
    expect(resolveInteractiveShellArgs("sh")).toEqual(["-i", "-l"]);
    expect(resolveInteractiveShellArgs("pwsh")).toEqual(["-NoLogo"]);
    expect(resolveInteractiveShellArgs("cmd")).toEqual([]);
  });

  it("strips zsh prompt spacing prelude from startup output while preserving real shell text", async () => {
    const logger = {
      warn: jest.fn(),
    };
    const terminalProcess = new TestTerminalProcess();
    const backend = {
      spawn: jest.fn(async () => terminalProcess as any),
    };
    const manager = new StudioTerminalSessionManager(
      {
        getLogger: () => logger,
      } as any,
      {
        backend: backend as any,
      }
    );

    const dataEvents: string[] = [];
    const unsubscribe = manager.subscribe(
      { projectPath: "SystemSculpt/Studio/ZshPromptFilter.systemsculpt", nodeId: "terminal_node_zsh_prompt_filter" },
      (event) => {
        if (event.type === "data") {
          dataEvents.push(event.data);
        }
      }
    );

    const snapshot = await manager.ensureSession({
      projectPath: "SystemSculpt/Studio/ZshPromptFilter.systemsculpt",
      nodeId: "terminal_node_zsh_prompt_filter",
      cwd: globalThis.process.cwd(),
      shellProfile: "zsh",
      cols: 120,
      rows: 32,
    });
    expect(snapshot.status).toBe("running");

    const promptSpacingPrelude =
      "\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m" +
      "                                                                                \r \r";
    const visiblePrompt = "\u001b[36m~/gits \u001b[37m➭ \u001b[00m\u001b[K\u001b[?1h\u001b=\u001b[?2004h";
    terminalProcess.emitData(`${promptSpacingPrelude}${visiblePrompt}`);

    const firstSnapshot = manager.getSnapshot({
      projectPath: "SystemSculpt/Studio/ZshPromptFilter.systemsculpt",
      nodeId: "terminal_node_zsh_prompt_filter",
    });
    expect(firstSnapshot?.history).toContain(visiblePrompt);
    expect(firstSnapshot?.history).not.toContain("\u001b[7m%");

    terminalProcess.emitData("% done\n");
    const secondSnapshot = manager.getSnapshot({
      projectPath: "SystemSculpt/Studio/ZshPromptFilter.systemsculpt",
      nodeId: "terminal_node_zsh_prompt_filter",
    });
    expect(secondSnapshot?.history).toContain("% done\n");
    expect(dataEvents.some((chunk) => chunk.includes("% done"))).toBe(true);

    await manager.stopSession({
      projectPath: "SystemSculpt/Studio/ZshPromptFilter.systemsculpt",
      nodeId: "terminal_node_zsh_prompt_filter",
    });
    unsubscribe();
    await manager.dispose();
  });

  it("strips zsh prompt spacing prelude even when the prelude spans multiple chunks", async () => {
    const logger = {
      warn: jest.fn(),
    };
    const terminalProcess = new TestTerminalProcess();
    const backend = {
      spawn: jest.fn(async () => terminalProcess as any),
    };
    const manager = new StudioTerminalSessionManager(
      {
        getLogger: () => logger,
      } as any,
      {
        backend: backend as any,
      }
    );

    const events: string[] = [];
    const unsubscribe = manager.subscribe(
      { projectPath: "SystemSculpt/Studio/ZshPromptSplit.systemsculpt", nodeId: "terminal_node_zsh_prompt_split" },
      (event) => {
        if (event.type === "data") {
          events.push(event.data);
        }
      }
    );

    const snapshot = await manager.ensureSession({
      projectPath: "SystemSculpt/Studio/ZshPromptSplit.systemsculpt",
      nodeId: "terminal_node_zsh_prompt_split",
      cwd: globalThis.process.cwd(),
      shellProfile: "zsh",
      cols: 120,
      rows: 32,
    });
    expect(snapshot.status).toBe("running");

    const chunk1 = "\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m" + "                                        ";
    const chunk2 = "                                        \r \r";
    const chunk3 = "\u001b[36m~/gits \u001b[37m➭ \u001b[00m\u001b[K\u001b[?1h\u001b=\u001b[?2004h";
    terminalProcess.emitData(chunk1);
    terminalProcess.emitData(chunk2);
    terminalProcess.emitData(chunk3);

    const nextSnapshot = manager.getSnapshot({
      projectPath: "SystemSculpt/Studio/ZshPromptSplit.systemsculpt",
      nodeId: "terminal_node_zsh_prompt_split",
    });
    expect(nextSnapshot?.history).toContain(chunk3);
    expect(nextSnapshot?.history).not.toContain("\u001b[7m%");
    expect(events.join("")).not.toContain("\u001b[7m%");

    await manager.stopSession({
      projectPath: "SystemSculpt/Studio/ZshPromptSplit.systemsculpt",
      nodeId: "terminal_node_zsh_prompt_split",
    });
    unsubscribe();
    await manager.dispose();
  });

  it("marks session failed and logs a readable warning when shell launch fails", async () => {
    const logger = {
      warn: jest.fn(),
    };
    const backend = {
      spawn: jest.fn(async () => {
        throw new Error("simulated launch failure");
      }),
    };
    const manager = new StudioTerminalSessionManager(
      {
        getLogger: () => logger,
      } as any,
      {
        backend: backend as any,
      }
    );

    const snapshot = await manager.ensureSession({
      projectPath: "SystemSculpt/Studio/Test.systemsculpt",
      nodeId: "terminal_node",
      cwd: globalThis.process.cwd(),
      shellProfile: "bash",
    });

    expect(snapshot.status).toBe("failed");
    expect(snapshot.errorMessage).toContain("simulated launch failure");
    expect(logger.warn).toHaveBeenCalled();
    expect(String(logger.warn.mock.calls[0]?.[0] || "")).toContain("Studio terminal failed to launch:");
    await manager.dispose();
  });

  it("keeps detached sidecar sessions alive during dispose when backend opts in", async () => {
    const logger = {
      warn: jest.fn(),
    };
    const terminalProcess = new TestTerminalProcess();
    const killSpy = jest.spyOn(terminalProcess, "kill");
    const backend = {
      keepsSessionsOnDispose: true,
      spawn: jest.fn(async () => terminalProcess as any),
      dispose: jest.fn(async () => undefined),
    };
    const manager = new StudioTerminalSessionManager(
      {
        getLogger: () => logger,
      } as any,
      {
        backend: backend as any,
      }
    );

    const snapshot = await manager.ensureSession({
      projectPath: "SystemSculpt/Studio/SidecarDispose.systemsculpt",
      nodeId: "terminal_node_sidecar_dispose",
      cwd: globalThis.process.cwd(),
      shellProfile: "bash",
    });

    expect(snapshot.status).toBe("running");
    await manager.dispose();
    expect(killSpy).not.toHaveBeenCalled();
    expect(backend.dispose).toHaveBeenCalledTimes(1);
  });

  it("hydrates local snapshot state from sidecar peek results", async () => {
    const logger = {
      warn: jest.fn(),
    };
    const backend = {
      spawn: jest.fn(async () => new TestTerminalProcess() as any),
      peekSession: jest.fn(async () => ({
        sessionId: "SystemSculpt/Studio/Peek.systemsculpt::terminal_node_peek",
        projectPath: "SystemSculpt/Studio/Peek.systemsculpt",
        nodeId: "terminal_node_peek",
        status: "running",
        cwd: globalThis.process.cwd(),
        shellProfile: "bash",
        shellCommand: "bash",
        shellArgs: ["-i", "-l"],
        cols: 120,
        rows: 30,
        history: "persisted output\\n",
        historyRevision: 7,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        exitCode: null,
        errorMessage: "",
      })),
    };
    const manager = new StudioTerminalSessionManager(
      {
        getLogger: () => logger,
      } as any,
      {
        backend: backend as any,
      }
    );

    const peeked = await manager.peekSession({
      projectPath: "SystemSculpt/Studio/Peek.systemsculpt",
      nodeId: "terminal_node_peek",
    });
    expect(peeked?.status).toBe("running");
    expect(peeked?.history).toContain("persisted output");

    const snapshot = manager.getSnapshot({
      projectPath: "SystemSculpt/Studio/Peek.systemsculpt",
      nodeId: "terminal_node_peek",
    });
    expect(snapshot?.historyRevision).toBe(7);
  });
});
