import { Platform } from "obsidian";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type SystemSculptPlugin from "../../main";
import { StudioTerminalRuntimeBootstrap } from "../StudioTerminalRuntimeBootstrap";
import type {
  StudioTerminalBackend,
  StudioTerminalProcess,
  StudioTerminalSpawnOptions,
} from "./StudioTerminalSessionTypes";

type NodePtyLike = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (listener: (data: string) => unknown) => unknown;
  onExit: (listener: (event: { exitCode: number; signal?: number }) => unknown) => unknown;
};

type NodePtyModuleLike = {
  spawn?: (file: string, args: string[], options: Record<string, unknown>) => NodePtyLike;
  default?: {
    spawn?: (file: string, args: string[], options: Record<string, unknown>) => NodePtyLike;
  };
};

type StudioRuntimeRequire = (id: string) => unknown;

function toDisposer(value: unknown): () => void {
  if (typeof value === "function") {
    return () => {
      try {
        value();
      } catch {}
    };
  }
  if (value && typeof value === "object" && typeof (value as { dispose?: () => void }).dispose === "function") {
    return () => {
      try {
        (value as { dispose: () => void }).dispose();
      } catch {}
    };
  }
  return () => {};
}

function resolveStudioRuntimeRequire(): StudioRuntimeRequire {
  const windowRequire =
    typeof window !== "undefined" ? (window as unknown as { require?: unknown }).require : undefined;
  if (typeof windowRequire === "function") {
    return windowRequire as StudioRuntimeRequire;
  }

  const globalRequire = (globalThis as { require?: unknown }).require;
  if (typeof globalRequire === "function") {
    return globalRequire as StudioRuntimeRequire;
  }

  throw new Error("Node require is unavailable; cannot load node-pty.");
}

export class NodePtyTerminalBackend implements StudioTerminalBackend {
  constructor(
    private readonly plugin: SystemSculptPlugin,
    options?: {
      runtimeBootstrap?: StudioTerminalRuntimeBootstrap;
    }
  ) {
    this.runtimeBootstrap = options?.runtimeBootstrap || new StudioTerminalRuntimeBootstrap(plugin);
  }

  private ptyModule: NodePtyModuleLike | null = null;
  private runtimeReadyPromise: Promise<void> | null = null;
  private readonly runtimeBootstrap: StudioTerminalRuntimeBootstrap;

  private resolveVaultBasePath(): string {
    const adapter = this.plugin.app.vault.adapter as {
      basePath?: unknown;
      getBasePath?: () => unknown;
      getFullPath?: (path: string) => unknown;
    };
    if (typeof adapter.getBasePath === "function") {
      const fromGetter = String(adapter.getBasePath() || "").trim();
      if (fromGetter) {
        return fromGetter;
      }
    }
    if (typeof adapter.basePath === "string" && adapter.basePath.trim().length > 0) {
      return adapter.basePath.trim();
    }
    if (typeof adapter.getFullPath === "function") {
      const fromFullPath = String(adapter.getFullPath("") || "").trim();
      if (fromFullPath) {
        return fromFullPath.replace(/[\\/]+$/, "");
      }
    }
    return "";
  }

  private resolvePluginInstallDir(): string {
    const manifestDir = String((this.plugin.manifest as { dir?: unknown }).dir || "").trim();
    if (manifestDir) {
      if (isAbsolute(manifestDir)) {
        return manifestDir;
      }
      const vaultBasePath = this.resolveVaultBasePath();
      if (vaultBasePath) {
        return join(vaultBasePath, manifestDir);
      }
    }

    const vaultBasePath = this.resolveVaultBasePath();
    const configDir = String(this.plugin.app.vault.configDir || "").trim();
    const pluginId = String(this.plugin.manifest.id || "").trim();
    if (vaultBasePath && configDir && pluginId) {
      return join(vaultBasePath, configDir, "plugins", pluginId);
    }

    throw new Error("Unable to resolve the plugin installation directory.");
  }

  private loadModuleFromPluginInstall(): NodePtyModuleLike {
    const runtimeRequire = resolveStudioRuntimeRequire();
    const pluginInstallDir = this.resolvePluginInstallDir();
    const absoluteModulePath = join(pluginInstallDir, "node_modules", "node-pty");
    if (!existsSync(absoluteModulePath)) {
      throw new Error(`node-pty runtime is missing at ${absoluteModulePath}`);
    }
    const loaded = runtimeRequire(absoluteModulePath);
    if (!loaded || (typeof loaded !== "object" && typeof loaded !== "function")) {
      throw new Error(`node-pty resolved to an invalid module value from ${absoluteModulePath}`);
    }
    return loaded as NodePtyModuleLike;
  }

  private async ensureRuntimeReady(): Promise<void> {
    if (this.runtimeReadyPromise) {
      await this.runtimeReadyPromise;
      return;
    }

    this.runtimeReadyPromise = (async () => {
      const pluginInstallDir = this.resolvePluginInstallDir();
      await this.runtimeBootstrap.ensureNodePtyRuntime(pluginInstallDir);
    })();

    try {
      await this.runtimeReadyPromise;
    } catch (error) {
      this.runtimeReadyPromise = null;
      throw error;
    }
  }

  private async loadModule(): Promise<NodePtyModuleLike> {
    if (this.ptyModule) {
      return this.ptyModule;
    }
    await this.ensureRuntimeReady();
    this.ptyModule = this.loadModuleFromPluginInstall();
    return this.ptyModule;
  }

  async spawn(options: StudioTerminalSpawnOptions): Promise<StudioTerminalProcess> {
    if (!Platform.isDesktopApp) {
      throw new Error("Interactive terminal sessions are desktop-only.");
    }

    const module = await this.loadModule();
    const spawnFn =
      (typeof module.spawn === "function" ? module.spawn : null) ||
      (typeof module.default?.spawn === "function" ? module.default.spawn : null);
    if (!spawnFn) {
      throw new Error("node-pty did not expose a spawn function.");
    }

    const pty = spawnFn(options.command, options.args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
    });

    return {
      write: (data) => {
        pty.write(data);
      },
      resize: (cols, rows) => {
        pty.resize(cols, rows);
      },
      kill: () => {
        pty.kill();
      },
      onData: (listener) => {
        return toDisposer(pty.onData(listener));
      },
      onExit: (listener) => {
        return toDisposer(pty.onExit(listener));
      },
    };
  }
}
