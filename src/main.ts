/**
 * SystemSculpt AI – Production Build
 * Stable initialization with background tasks deferred for responsiveness.
 */

/**
 * Initialize error capture at the very beginning, before anything else loads
 */
// Initialize plugin

// @ts-ignore - Import ErrorCollectorService first, out of order
import { ErrorCollectorService } from "./services/ErrorCollectorService";

// Logging disabled – retain call for backwards compatibility only
ErrorCollectorService.initializeEarlyLogsCapture();

/**
 * SystemSculpt AI Plugin for Obsidian
 */
import { Plugin, Notice, FileSystemAdapter, apiVersion } from "obsidian";
export { StudioProjectGenerationStore } from "./studio/persistence/StudioProjectGenerationStore";
export { ObsidianStudioGenerationAdapter } from "./studio/persistence/ObsidianStudioGenerationAdapter";
import { checkObsidianCompatibility, MINIMUM_OBSIDIAN_VERSION } from "./core/plugin/lifecycle/ObsidianCompat";
import { SystemSculptSettings, DEFAULT_SETTINGS, LogLevel, LICENSE_URL } from "./types";
import { SystemSculptService, type CreditsBalanceSnapshot } from "./services/SystemSculptService";
import { SystemSculptSettingTab } from "./settings/SystemSculptSettingTab";
import type { RecorderService } from "./services/RecorderService";
import { TranscriptionService } from "./services/TranscriptionService";
import type { FileContextMenuService } from "./context-menu/FileContextMenuService";
import { SettingsManager } from "./core/settings/SettingsManager";
import { LicenseManager } from "./core/license/LicenseManager";
import type { ViewManager } from "./core/plugin/views";
import type { CommandManager } from "./core/plugin/commands";
import { setLogLevel } from "./utils/errorHandling";
import { errorLogger } from "./utils/errorLogger";
import { DirectoryManager } from "./core/DirectoryManager";
import { StorageManager } from "./core/storage";
import { ResumeChatService } from "./views/chatview/ResumeChatService";
import { EmbeddingsManager } from "./services/embeddings/EmbeddingsManager";
import { VaultFileCache } from "./utils/VaultFileCache";
import { EmbeddingsStatusBar } from "./components/EmbeddingsStatusBar";
import { FreezeMonitor } from "./services/FreezeMonitor";
import { ResourceMonitorService } from "./services/ResourceMonitorService";
import { PluginLogger } from "./utils/PluginLogger";
import { InitializationTracer } from "./core/diagnostics/InitializationTracer";
import { hasHostCapability, openLocalFolder } from "./platform/hostCapabilities";
import { disposeMobileHostLayoutStates } from "./platform/mobileHostLayout";
import { yieldToEventLoop } from "./utils/yieldToEventLoop";
import { PlatformContext } from "./services/PlatformContext";
import { tryCopyToClipboard } from "./utils/clipboard";
import { EventEmitter } from "./core/EventEmitter";
import { LifecycleCoordinator, LifecycleFailureEvent } from "./core/plugin/lifecycle/LifecycleCoordinator";
import { WorkflowEngineService } from "./services/workflow/WorkflowEngineService";
import type { SystemSculptSearchEngine } from "./services/search/SystemSculptSearchEngine";
import { relativeLineNumbersExtension } from "./editor/relative-line-numbers";
import { type Extension } from "@codemirror/state";
import type { StudioService } from "./studio/StudioService";
import { SYSTEMSCULPT_STUDIO_VIEW_TYPE } from "./core/plugin/viewTypes";
import { API_BASE_URL } from "./constants/api";
import { ManagedCapabilityClient } from "./services/managed/ManagedCapabilityClient";
import { ManagedCapabilityClientFactory, type ManagedCapabilityClientGraph } from "./services/managed/ManagedCapabilityClientFactory";
import { PluginUpdateService } from "./services/PluginUpdateService";
import { PostProcessingService } from "./services/PostProcessingService";
import { AudioTranscriptionPanel } from "./modals/AudioTranscriptionPanel";

type ViewManagerModule = typeof import("./core/plugin/views");
type CommandManagerModule = typeof import("./core/plugin/commands");
type StudioServiceModule = typeof import("./studio/StudioService");
type SystemSculptSearchEngineModule = typeof import("./services/search/SystemSculptSearchEngine");
type RecorderServiceModule = typeof import("./services/RecorderService");
type FileContextMenuServiceModule = typeof import("./context-menu/FileContextMenuService");

function loadViewManagerModule(): ViewManagerModule {
  return require("./core/plugin/views");
}

function loadCommandManagerModule(): CommandManagerModule {
  return require("./core/plugin/commands");
}

function loadStudioServiceModule(): StudioServiceModule {
  return require("./studio/StudioService");
}

function loadSystemSculptSearchEngineModule(): SystemSculptSearchEngineModule {
  return require("./services/search/SystemSculptSearchEngine");
}

function loadRecorderServiceModule(): RecorderServiceModule {
  return require("./services/RecorderService");
}

function loadFileContextMenuServiceModule(): FileContextMenuServiceModule {
  return require("./context-menu/FileContextMenuService");
}

export default class SystemSculptPlugin extends Plugin {
  // Make internalSettings public but indicate it's for manager use only
  public _internal_settings_systemsculpt_plugin: SystemSculptSettings;
  // Keep the getter for general readonly access
  get settings(): SystemSculptSettings {
    return this._internal_settings_systemsculpt_plugin;
  }

  private _aiService: SystemSculptService | undefined;
  settingsTab: SystemSculptSettingTab;
  private recorderService: RecorderService | null = null;
  private transcriptionService: TranscriptionService;
  private settingsManager: SettingsManager;
  private licenseManager: LicenseManager;
  private viewManager: ViewManager | null = null;
  private commandManager: CommandManager;
  private fileContextMenuService: FileContextMenuService | null = null;
  private isUnloading = false;
  private isPreloadingDone = false;
  private failures: string[] = [];
  /** True once a fatal load failure has put the plugin into minimal recovery mode. */
  private safeMode = false;
  emitter: EventEmitter;
  directoryManager: DirectoryManager;
  private errorCollectorService: ErrorCollectorService;
  public resumeChatService: ResumeChatService;
  public storage: StorageManager;
  private pluginLogger: PluginLogger | null = null;
  private initializationTracer: InitializationTracer | null = null;
  public embeddingsManager: EmbeddingsManager | null = null;
  public vaultFileCache: VaultFileCache;
  public embeddingsStatusBar: EmbeddingsStatusBar | null = null;
  private resourceMonitor: ResourceMonitorService | null = null;
  private lifecycleCoordinator: LifecycleCoordinator | null = null;
  private diagnosticsSessionId: string | null = null;
  private diagnosticsLogFileName = "systemsculpt-latest.log";
  private diagnosticsMetricsFileName = "resource-metrics-latest.ndjson";
  private workflowEngineService: WorkflowEngineService | null = null;
  private searchEngine: SystemSculptSearchEngine | null = null;
  private studioService: StudioService | null = null;
  private managedCapabilityGraph: ManagedCapabilityClientGraph | null = null;
  private pluginUpdateService: PluginUpdateService | null = null;
  /** Live-reconfigurable slot for the relative line number gutter editor extension. */
  private readonly relativeLineNumberExtensions: Extension[] = [];
  private relativeLineNumbersApplied = false;
  private pendingSettingsFocusTab: string | null = null;
  // Removed complex settings callback system - embeddings are now completely on-demand

  // Simple initialization tracking
  private embeddingsInitialized = false;

  private criticalInitializationPromise: Promise<void> | null = null;
  private deferredInitializationPromise: Promise<void> | null = null;
  private managersInitialized = false;
  private managersInitializationPromise: Promise<void> | null = null;
  private hasRegisteredStudioExtensions = false;
  
  // Lazy service getters to avoid blocking startup
  public get aiService(): SystemSculptService {
    if (!this._aiService) {
      this._aiService = SystemSculptService.getInstance(this);
    }
    return this._aiService;
  }

  public getManagedCapabilityClient(): ManagedCapabilityClient {
    return this.getManagedCapabilityGraph().client;
  }

  public getManagedCapabilityGraph(): ManagedCapabilityClientGraph {
    if (!this.managedCapabilityGraph) this.managedCapabilityGraph = ManagedCapabilityClientFactory.createGraph({
      baseUrl: new URL(API_BASE_URL).origin, pluginVersion: this.manifest.version,
      licenseKey: () => this.settings.licenseKey,
    });
    return this.managedCapabilityGraph;
  }

  /**
   * Get or create embeddings manager - simple and reliable
   */
  public getOrCreateEmbeddingsManager(): EmbeddingsManager {
    if (!this.embeddingsManager) {
      this.embeddingsManager = new EmbeddingsManager(this.app, this);

      // Initialize in background if not already done
      if (!this.embeddingsInitialized) {
        this.embeddingsInitialized = true;
        this.embeddingsManager
          .initialize()
          .catch((error) => {
            const logger = this.getLogger();
            logger.error("Embeddings manager background initialization failed", error, {
              source: "SystemSculptPlugin",
            });
          });
      }
    }

    const manager = this.embeddingsManager;
    if (this.settings.embeddingsEnabled) {
      this.embeddingsStatusBar?.startMonitoring(manager);
    }
    return manager;
  }

  public getSearchEngine(): SystemSculptSearchEngine {
    if (!this.searchEngine) {
      const { SystemSculptSearchEngine } = loadSystemSculptSearchEngineModule();
      this.searchEngine = new SystemSculptSearchEngine(this.app, this);
    }
    return this.searchEngine;
  }

  public getPluginLogger(): PluginLogger | null {
    return this.pluginLogger;
  }

  private getInitializationTracer(): InitializationTracer {
    if (!this.initializationTracer) {
      this.initializationTracer = new InitializationTracer(() => this.getLogger());
    }

    return this.initializationTracer;
  }

  private async waitForCriticalInitialization(): Promise<void> {
    if (!this.criticalInitializationPromise) {
      return;
    }

    await this.criticalInitializationPromise;
  }

  private async prepareDiagnosticsSession(): Promise<void> {
    if (this.diagnosticsSessionId) {
      return;
    }

    if (!this.storage) {
      this.storage = new StorageManager(this.app, this);
    }

    try {
      await this.storage.initialize();
    } catch (error) {
      console.warn("[SystemSculpt][Diagnostics] Failed to initialize storage", error);
    }

    const timestamp = this.formatDiagnosticsFileTimestamp(new Date());
    this.diagnosticsSessionId = timestamp;

    const header = `SystemSculpt diagnostics session ${timestamp} (plugin v${this.manifest.version})\n`;
    await this.rotateDiagnosticsFile(this.diagnosticsLogFileName, `systemsculpt-${timestamp}.log`, header);
    await this.rotateDiagnosticsFile(this.diagnosticsMetricsFileName, `resource-metrics-${timestamp}.ndjson`);

    const metadata = {
      sessionId: timestamp,
      startedAt: new Date().toISOString(),
      pluginVersion: this.manifest.version,
      vaultName: typeof this.app.vault.getName === "function" ? this.app.vault.getName() : "",
      obsidianConfigDir: this.app.vault.configDir,
      enabledPlugins: this.collectEnabledPluginIds(),
    };

    try {
      await this.storage!.writeFile("diagnostics", "session-latest.json", metadata);
      await this.storage!.writeFile("diagnostics", `session-${timestamp}.json`, metadata);
    } catch (error) {
      console.warn("[SystemSculpt][Diagnostics] Failed to write session metadata", error);
    }

    if (this.pluginLogger) {
      this.pluginLogger.setLogFileName(this.diagnosticsLogFileName);
    }
  }

  private async rotateDiagnosticsFile(latestName: string, archiveName: string, header?: string): Promise<void> {
    if (!this.storage) {
      return;
    }
    const adapter = this.app.vault.adapter;
    if (!adapter) {
      return;
    }
    const basePath = this.storage.getPath("diagnostics");
    const latestPath = `${basePath}/${latestName}`;
    const archivePath = `${basePath}/${archiveName}`;

    try {
      const exists = await adapter.exists(latestPath);
      if (exists) {
        await adapter.rename(latestPath, archivePath);
      }
    } catch (error) {
      console.warn("[SystemSculpt][Diagnostics] Failed to rotate file", {
        file: latestName,
        error,
      });
    }

    try {
      await adapter.write(latestPath, header ?? "");
    } catch (error) {
      console.warn("[SystemSculpt][Diagnostics] Failed to reset file", {
        file: latestName,
        error,
      });
    }
  }

  private collectEnabledPluginIds(): string[] {
    const pluginManager = (this.app as any)?.plugins;
    if (!pluginManager) {
      return [];
    }

    if (pluginManager.enabledPlugins instanceof Set) {
      return Array.from(pluginManager.enabledPlugins);
    }

    if (Array.isArray(pluginManager.enabledPlugins)) {
      return [...pluginManager.enabledPlugins];
    }

    return [];
  }

  async onload() {
    const loadStart = performance.now();
    // Injected by esbuild `define`; "dev" outside the bundler (tests).
    const buildStamp =
      typeof __SS_BUILD_STAMP__ !== "undefined" ? __SS_BUILD_STAMP__ : "dev";
    // Plain console line (not just the plugin logger) so any vault can
    // answer "which build am I running?" straight from devtools.
    console.debug(
      `[SystemSculpt] v${this.manifest.version} build ${buildStamp}`
    );
    const tracer = this.getInitializationTracer();
    const onloadPhase = tracer.startPhase("plugin.onload", {
      slowThresholdMs: 5000,
      timeoutMs: 60000,
      metadata: {
        version: this.manifest.version,
      },
    });

    const logger = this.getLogger();
    logger.info("SystemSculpt plugin onload starting", {
      source: "SystemSculptPlugin",
      metadata: {
        version: this.manifest.version,
        build: buildStamp,
      },
    });

    try {
      this.warnIfObsidianVersionUnsupported();
      this.configureLifecycle();
      if (!this.lifecycleCoordinator) {
        throw new Error("Lifecycle coordinator failed to initialize");
      }

      await this.lifecycleCoordinator.runPhase("bootstrap");

      this.startCriticalAndDeferredPhases(tracer, logger);

      this.registerLayoutReadyHandler(loadStart);

      onloadPhase.complete({
        totalMs: Number((performance.now() - loadStart).toFixed(1)),
        failureCount: this.failures.length,
      });
    } catch (error) {
      this.failures.push("core initialization");
      onloadPhase.fail(error, {
        failureCount: this.failures.length,
      });
      tracer.flushOpenPhases("plugin.onload-error");

      if (this.errorCollectorService) {
        this.errorCollectorService.captureError("Plugin load", error);
      } else {
        logger.error("Plugin load failed before error collector ready", error, {
          source: "SystemSculptPlugin",
        });
      }

      this.enterSafeMode("core initialization failed");
    }

    if (this.failures.length > 0 && !this.safeMode) {
      logger.warn("Initialization reported recoverable issues", {
        source: "SystemSculptPlugin",
        metadata: {
          failures: [...this.failures],
        },
      });
      this.showErrorNotice(
        `SystemSculpt had issues with: ${this.failures.join(", ")}. Some features may be unavailable.`
      );
    }
  }

  /**
   * Fail-soft Obsidian version gate (#212/#147). If the running Obsidian is
   * older than the verified minimum, surface ONE clear notice and continue
   * best-effort — never hard-block. An unreadable app version is treated as
   * supported. Safe to call before any service exists.
   */
  /** Indirection over the `obsidian` apiVersion export so tests can drive the gate. */
  protected getObsidianApiVersion(): string | undefined {
    return apiVersion;
  }

  private warnIfObsidianVersionUnsupported(): void {
    try {
      const compat = checkObsidianCompatibility(this.getObsidianApiVersion(), MINIMUM_OBSIDIAN_VERSION);
      if (compat.supported) {
        return;
      }
      this.failures.push("unsupported Obsidian version");
      this.getInitializationTracer().markMilestone("obsidian.version.unsupported", {
        current: compat.currentVersion,
        minimum: compat.minimumVersion,
      });
      new Notice(
        `SystemSculpt AI needs Obsidian ${compat.minimumVersion} or newer (you have ${compat.currentVersion}). ` +
          `Some features may not work until you update Obsidian.`,
        15000
      );
    } catch {
      // Version gate must never break load.
    }
  }

  /**
   * Enter minimal recovery mode after a fatal load failure (#212/#183). Instead
   * of silently degrading, register a single recovery command that surfaces
   * diagnostics and tell the user their settings are safe. Idempotent and
   * defensive — it runs on the failure path and must not throw.
   */
  private enterSafeMode(reason: string): void {
    if (this.safeMode) {
      return;
    }
    this.safeMode = true;
    try {
      this.addCommand({
        id: "systemsculpt-show-load-diagnostics",
        name: "Show load diagnostics (safe mode)",
        callback: () => {
          new Notice(
            `SystemSculpt AI did not finish loading (${reason}). Your settings and backups are safe. ` +
              `Details:\n${this.collectErrorDetails()}`,
            0
          );
        },
      });
    } catch {
      // Command registration is best-effort in a degraded host.
    }
    try {
      this.showErrorNotice(
        `SystemSculpt AI could not finish loading (${reason}). Your settings are safe — run ` +
          `"Show load diagnostics (safe mode)" from the command palette for details.`
      );
    } catch {
      // Notice is best-effort.
    }
  }

  private configureLifecycle(): void {
    const tracer = this.getInitializationTracer();
    const logger = this.getLogger();
    this.lifecycleCoordinator = new LifecycleCoordinator({
      tracer,
      logger,
      onTaskFailure: (event) => this.handleLifecycleFailure(event),
    });

    this.registerBootstrapTasks(this.lifecycleCoordinator);
    this.registerCriticalTasks(this.lifecycleCoordinator);
    this.registerDeferredTasks(this.lifecycleCoordinator);
    this.registerLayoutTasks(this.lifecycleCoordinator);
  }

  private registerBootstrapTasks(coordinator: LifecycleCoordinator): void {
    const tracer = this.getInitializationTracer();

    coordinator.registerTask("bootstrap", {
      id: "storage.prepare",
      label: "storage manager",
      run: async () => {
        if (!this.storage) {
          this.storage = new StorageManager(this.app, this);
        }
        await this.prepareDiagnosticsSession();
      },
    });

    coordinator.registerTask("bootstrap", {
      id: "platform.bootstrap",
      label: "platform bootstrap",
      run: () => {
        this._internal_settings_systemsculpt_plugin = { ...DEFAULT_SETTINGS };
        tracer.markMilestone("defaults-applied", {
          settingsKeys: Object.keys(DEFAULT_SETTINGS).length,
        });

        PlatformContext.initialize();
        // Registered empty; filled in / cleared by syncRelativeLineNumbersExtension()
        // once settings load and whenever the toggle changes.
        this.registerEditorExtension(this.relativeLineNumberExtensions);
        this.ensureSettingsManagerInstance();
      },
    });

    coordinator.registerTask("bootstrap", {
      id: "settings.tab.register",
      label: "settings tab",
      optional: true,
      run: () => {
        this.ensureSettingsTab();
      },
    });

    coordinator.registerTask("bootstrap", {
      id: "monitor.freeze",
      label: "freeze monitor",
      optional: true,
      run: () => {
        FreezeMonitor.start({ thresholdMs: 150, minReportIntervalMs: 2000 });
      },
    });

    coordinator.registerTask("bootstrap", {
      id: "workspace.events",
      label: "workspace events",
      optional: true,
      run: () => {
        this.registerEvent(
          this.app.workspace.on("active-leaf-change", (leaf) => {
            FreezeMonitor.mark("workspace:active-leaf-change:start", { hasLeaf: !!leaf });
          })
        );

        this.registerEvent(
          this.app.workspace.on("systemsculpt:settings-updated", () => {
            try {
              this.embeddingsManager?.syncFromSettings();
            } catch (error) {
              const logger = this.getLogger();
              logger.error("Embeddings manager settings sync failed", error, {
                source: "SystemSculptPlugin",
              });
            }

            try {
              this.syncRelativeLineNumbersExtension();
            } catch (error) {
              const logger = this.getLogger();
              logger.error("Relative line numbers settings sync failed", error, {
                source: "SystemSculptPlugin",
              });
            }
          })
        );

      },
    });

    coordinator.registerTask("bootstrap", {
      id: "services.errorCollector",
      label: "error collector",
      run: () => {
        this.errorCollectorService = new ErrorCollectorService(500);
        this.errorCollectorService.enableCaptureAllLogs();
      },
    });

    coordinator.registerTask("bootstrap", {
      id: "services.pluginUpdates",
      label: "plugin updates",
      optional: true,
      run: () => {
        this.pluginUpdateService = new PluginUpdateService(this);
      },
    });

    coordinator.registerTask("bootstrap", {
      id: "logging.ready",
      label: "plugin logger",
      optional: true,
      run: () => {
        this.pluginLogger?.info("Plugin logger ready", {
          source: "SystemSculptPlugin",
          metadata: {
            version: this.manifest.version,
          },
        });
      },
    });

    coordinator.registerTask("bootstrap", {
      id: "monitor.resources",
      label: "resource monitor",
      optional: true,
      run: () => {
        this.resourceMonitor = new ResourceMonitorService(this, {
          metricsFileName: this.diagnosticsMetricsFileName,
          sessionId: this.diagnosticsSessionId ?? undefined,
        });
        this.resourceMonitor.start();
      },
    });

    coordinator.registerTask("bootstrap", {
      id: "storage.initialize",
      label: "storage",
      optional: true,
      run: () => {
        this.scheduleStorageInitialization(tracer);
      },
    });
  }

  private registerCriticalTasks(coordinator: LifecycleCoordinator): void {
    coordinator.registerTask("critical", {
      id: "init.critical",
      label: "critical initialization",
      run: async () => {
        await this.runCriticalInitialization();
      },
    });

    coordinator.registerTask("critical", {
      id: "commands.register",
      label: "command registration",
      optional: true,
      run: () => {
        const tracer = this.getInitializationTracer();
        const phase = tracer.startPhase("commands.register", {
          slowThresholdMs: 300,
          timeoutMs: 3000,
        });
        try {
          this.registerCommands();
          phase.complete();
        } catch (error) {
          this.failures.push("command registration");
          phase.fail(error);
          throw error;
        }
      },
    });
  }

  private registerDeferredTasks(coordinator: LifecycleCoordinator): void {
    coordinator.registerTask("deferred", {
      id: "init.deferred",
      label: "deferred initialization",
      run: async () => {
        await this.runDeferredInitialization();
      },
    });
  }

  private registerLayoutTasks(coordinator: LifecycleCoordinator): void {
    coordinator.registerTask("layout", {
      id: "updates.start",
      label: "update notifications",
      optional: true,
      run: () => {
        if (this.pluginUpdateService) void this.pluginUpdateService.start();
      },
    });

    coordinator.registerTask("layout", {
      id: "embeddings.autostart",
      label: "embeddings auto-start",
      optional: true,
      diagnostics: {
        slowThresholdMs: 30_000,
        timeoutMs: 120_000,
      },
      run: async () => {
        if (!this.settings.embeddingsEnabled) {
          return;
        }

        const tracer = this.getInitializationTracer();
        const embeddingsPhase = tracer.startPhase("embeddings.autostart", {
          slowThresholdMs: 8000,
          timeoutMs: 60000,
        });
        try {
          const manager = this.getOrCreateEmbeddingsManager();
          await manager.awaitReady();
          this.embeddingsStatusBar?.startMonitoring(manager);
          embeddingsPhase.complete();
        } catch (error) {
          embeddingsPhase.fail(error);
        }
      },
    });
  }

  private handleLifecycleFailure(event: LifecycleFailureEvent): void {
    const label = event.label ?? event.taskId;
    this.failures.push(label);
    if (!event.optional && this.errorCollectorService) {
      const error = event.error instanceof Error ? event.error : new Error(String(event.error ?? "Unknown error"));
      this.errorCollectorService.captureError(`Lifecycle task failed: ${label}`, error);
    }
  }

  private startCriticalAndDeferredPhases(tracer: InitializationTracer, logger: PluginLogger): void {
    if (!this.lifecycleCoordinator) {
      return;
    }

    this.criticalInitializationPromise = (async () => {
      await yieldToEventLoop();
      if (this.isUnloading) {
        return;
      }
      await this.lifecycleCoordinator!.runPhase("critical");
    })();

    this.criticalInitializationPromise
      .then(() => {
        this.bootstrapPostCriticalServices(tracer, logger);
      })
      .catch((error) => {
        const failureError =
          error instanceof Error ? error : new Error(String(error ?? "critical initialization failed"));
        this.failures.push("critical initialization");
        tracer.flushOpenPhases("critical-initialization-error");
        logger.error("Critical initialization failed", failureError, {
          source: "SystemSculptPlugin",
          method: "runCriticalInitialization",
        });
      });

    this.deferredInitializationPromise = this.criticalInitializationPromise.then(async () => {
      await yieldToEventLoop();
      if (this.isUnloading) {
        return;
      }
      await this.lifecycleCoordinator!.runPhase("deferred");
    });

    this.deferredInitializationPromise.catch((error) => {
      const failureError =
        error instanceof Error ? error : new Error(String(error ?? "deferred initialization failed"));
      this.failures.push("deferred initialization");
      tracer.flushOpenPhases("deferred-initialization-error");
      logger.error("Deferred initialization failed", failureError, {
        source: "SystemSculptPlugin",
        method: "runDeferredInitialization",
      });
    });
  }

  private bootstrapPostCriticalServices(tracer: InitializationTracer, logger: PluginLogger): void {
    this.waitForCriticalInitialization()
      .then(() => {
        if (this.isUnloading) {
          return;
        }
        try {
          logger.debug("Starting file context menu service after critical initialization", {
            source: "SystemSculptPlugin",
          });
          this.setupFileContextMenuService();
          tracer.markMilestone("file-context-menu-ready");
        } catch (error) {
          this.failures.push("file context menu service");
          logger.error("Failed to set up file context menu service after critical initialization", error, {
            source: "SystemSculptPlugin",
          });
        }
      })
      .catch((error) => {
        const failureError = error instanceof Error ? error : new Error(String(error ?? "critical initialization failed"));
        logger.warn("File context menu service initialization skipped", {
          source: "SystemSculptPlugin",
          metadata: {
            reason: "critical initialization failed",
            error: failureError.message,
          },
        });
      });
  }

  private registerLayoutReadyHandler(loadStart: number): void {
    const tracer = this.getInitializationTracer();
    this.app.workspace.onLayoutReady(() => {
      const layoutPhase = tracer.startPhase("workspace.layoutReady", {
        slowThresholdMs: 15000,
        timeoutMs: 120000,
        metadata: {
          registeredAtMs: Number((performance.now() - loadStart).toFixed(1)),
        },
      });

      const lifecycle = this.lifecycleCoordinator;
      if (!lifecycle) {
        layoutPhase.complete({ skipped: true });
        return;
      }

      lifecycle
        .runPhase("layout")
        .then(() => {
          layoutPhase.complete({
            elapsedSinceLoadMs: Number((performance.now() - loadStart).toFixed(1)),
          });
        })
        .catch((error) => {
          this.failures.push("layout initialization");
          layoutPhase.fail(error);
        });
    });
  }

  private scheduleStorageInitialization(tracer: InitializationTracer): void {
    const storageBootstrapPhase = tracer.startPhase("storage.manager.initialize", {
      slowThresholdMs: 750,
      timeoutMs: 8000,
    });
    const timer = typeof window !== "undefined" && typeof window.setTimeout === "function" ? window.setTimeout : setTimeout;
    timer(() => {
      if (!this.storage) {
        storageBootstrapPhase.fail(new Error("Storage manager unavailable"));
        return;
      }
      this.storage
        .initialize()
        .then(() => {
          storageBootstrapPhase.complete();
          tracer.markMilestone("storage-initialized");
        })
        .catch((error) => {
          this.failures.push("storage");
          storageBootstrapPhase.fail(error);
        });
    }, 0);
  }

  private showUserNotice(message: string) {
    new Notice(message, 8000); // Show for 8 seconds to ensure visibility
  }

  private showErrorNotice(message: string) {
    new Notice(message, 15000);
  }

  /**
   * Collect detailed error information for reporting
   */
  private collectErrorDetails(): string {
    const details = [];

    // Add version info
    details.push(`SystemSculpt Version: ${this.manifest.version}`);
    details.push(`Obsidian Version: ${this.app.vault.configDir.split('/').pop() || 'Unknown'}`);

    // Add failure details
    details.push(`\nFailures: ${this.failures.join(", ")}`);

    // Add initialization state info
    details.push(`\nInitialization State:`);
    details.push(`- Directory Manager Initialized: ${this.directoryManager?.isInitialized() || false}`);
    details.push(`- Settings Loaded: ${!!this.settings}`);

    // Add directory verification info if available
    if (this.directoryManager) {
      this.directoryManager.verifyDirectories().then(({valid, issues}) => {
        if (!valid) {
          details.push(`\nDirectory Issues:`);
          issues.forEach(issue => details.push(`- ${issue}`));
        }
      }).catch(e => {
        details.push(`\nError verifying directories: ${e.message}`);
      });
    }

    // Add any captured error summaries (kept for backwards compatibility)
    details.push(`\nRecent Error Notes:`);

    const recentErrors = this.getRecentSystemSculptErrors();
    recentErrors.forEach(error => details.push(error));

    return details.join('\n');
  }

  /**
   * Get recent SystemSculpt-related console errors
   */
  private getRecentSystemSculptErrors(): string[] {
    if (this.errorCollectorService) {
      return this.errorCollectorService.getErrorLogs();
    }

    // Fallback if error collector not available
    const errors: string[] = [];
    const now = new Date();

    this.failures.forEach((failure) => {
      errors.push(`[${now.toISOString()}] Error with: ${failure}`);
    });

    return errors;
  }

  /**
   * Get all SystemSculpt-related console logs
   */
  public getAllSystemSculptLogs(): string[] {
    if (this.errorCollectorService) {
      return this.errorCollectorService.getAllLogs();
    }

    if (this.pluginLogger) {
      return this.pluginLogger
        .getRecentEntries()
        .map((entry) => `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`);
    }

    return [];
  }

  public buildDiagnosticsSnapshot(logLines: number = 200, resourceLines: number = 8): string {
    const lines: string[] = [];
    const now = new Date().toISOString();
    lines.push(`SystemSculpt Diagnostics — ${now}`);
    lines.push(`Plugin version: ${this.manifest.version}`);
    lines.push(`Obsidian config dir: ${this.app.vault.configDir}`);
    lines.push(`Failures: ${this.failures.length ? this.failures.join(", ") : "None"}`);
    lines.push("");
    lines.push("Resource usage:");
    const monitor = this.getResourceMonitor();
    if (monitor) {
      lines.push(monitor.buildSummary(resourceLines));
    } else {
      lines.push("Resource monitor not running.");
    }
    lines.push("");
    const logs = this.getAllSystemSculptLogs();
    lines.push(`Recent logs (latest ${Math.min(logLines, logs.length)} entries):`);
    if (logs.length === 0) {
      lines.push("No logs captured yet.");
    } else {
      logs.slice(-logLines).forEach((log) => lines.push(log));
    }
    return lines.join("\n");
  }

  public async exportDiagnosticsSnapshot(
    logLines: number = 200,
    resourceLines: number = 8
  ): Promise<{ text: string; path?: string }> {
    const snapshot = this.buildDiagnosticsSnapshot(logLines, resourceLines);
    if (!this.storage) {
      return { text: snapshot };
    }
    const fileName = `diagnostics-${this.formatDiagnosticsFileTimestamp(new Date())}.txt`;
    const result = await this.storage.writeFile("diagnostics", fileName, snapshot);
    return {
      text: snapshot,
      path: result.success ? result.path : undefined,
    };
  }

  private formatDiagnosticsFileTimestamp(date: Date): string {
    const pad = (value: number) => value.toString().padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      "-",
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds()),
    ].join("");
  }

  private async runCriticalInitialization() {
    const tracer = this.getInitializationTracer();
    const phase = tracer.startPhase("init.critical", {
      slowThresholdMs: 6000,
      timeoutMs: 45000,
    });
    const logger = this.getLogger();

    try {
      this.emitter = new EventEmitter();
      logger.debug("Event emitter ready for critical initialization", {
        source: "SystemSculptPlugin",
      });

      await this.initializeSettings();

      const parallelTasks = [
        this.initializeDirectories(),
        this.initializeVaultFileCache(),
        this.initializeBasicServices(),
      ];

      const results = await Promise.allSettled(parallelTasks);
      tracer.markMilestone("critical-parallel-tasks", {
        statuses: results.map((result) => result.status),
      });

      await this.initializeBasicUI();

      phase.complete();
    } catch (error) {
      phase.fail(error);

      logger.error("Critical initialization aborted", error, {
        source: "SystemSculptPlugin",
      });

      throw error;
    }
  }

  private async initializeDirectories() {
    const tracer = this.getInitializationTracer();
    const phase = tracer.startPhase("directories.initialize", {
      slowThresholdMs: 800,
      timeoutMs: 8000,
    });
    const logger = this.getLogger();

    try {
      this.directoryManager = new DirectoryManager(this.app, this);
      await this.directoryManager.initialize();

      logger.info("Directory manager initialized", {
        source: "SystemSculptPlugin",
      });

      phase.complete();
    } catch (error) {
      this.failures.push("directories");
      phase.fail(error);

      logger.error("Directory manager failed to initialize", error, {
        source: "SystemSculptPlugin",
      });
    }
  }

  private async initializeVaultFileCache() {
    const tracer = this.getInitializationTracer();
    const phase = tracer.startPhase("cache.vaultFile.initialize", {
      slowThresholdMs: 600,
      timeoutMs: 6000,
    });
    const logger = this.getLogger();

    try {
      this.vaultFileCache = new VaultFileCache(this.app);
      await this.vaultFileCache.initialize();

      logger.info("Vault file cache primed", {
        source: "SystemSculptPlugin",
      });

      phase.complete();
    } catch (error) {
      phase.fail(error);

      logger.warn("Vault file cache unavailable", {
        source: "SystemSculptPlugin",
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async runDeferredInitialization() {
    const tracer = this.getInitializationTracer();
    const phase = tracer.startPhase("init.deferred", {
      slowThresholdMs: 12000,
      timeoutMs: 90000,
    });
    const logger = this.getLogger();

    if (this.isUnloading) {
      phase.complete({ skipped: true });
      return;
    }

    try {
      await this.initializeRemainingServices();
      await this.initializeManagers();

      void this.initializeLicense().finally(() => {
        if (this.isUnloading) return;
        try {
          this.ensureRecorderService().recoverPendingCaptures();
        } catch (error) {
          logger.warn("Recorder recovery initialization failed", {
            source: "SystemSculptPlugin",
            metadata: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      });

      await this.preloadDataInBackground();

      if (this.viewManager) {
        const restorePhase = tracer.startPhase("views.restore", {
          slowThresholdMs: 4000,
          timeoutMs: 15000,
          successLevel: "debug",
        });
        try {
          await this.viewManager.restoreChatViews();
          restorePhase.complete();
        } catch (error) {
          restorePhase.fail(error);
          logger.warn("Failed to restore chat views", {
            source: "SystemSculptPlugin",
            metadata: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }

      phase.complete();
    } catch (error) {
      phase.fail(error);

      logger.error("Deferred initialization aborted", error, {
        source: "SystemSculptPlugin",
      });

      throw error;
    }
  }

  private ensureSettingsManagerInstance(): SettingsManager {
    if (!this.settingsManager) {
      this.settingsManager = new SettingsManager(this);
    }

    return this.settingsManager;
  }

  /**
   * Initialize settings using Obsidian's native data API
   * Implements robust error handling to prevent settings loss
   */
  private async initializeSettings() {
    const tracer = this.getInitializationTracer();
    const phase = tracer.startPhase("settings.load", {
      slowThresholdMs: 600,
      timeoutMs: 8000,
    });
    const logger = this.getLogger();

    try {
      const settingsManager = this.ensureSettingsManagerInstance();
      await settingsManager.loadSettings();
      this._internal_settings_systemsculpt_plugin = settingsManager.getSettings();
      try {
        this.syncRelativeLineNumbersExtension();
      } catch (error) {
        logger.error("Relative line numbers startup sync failed", error, {
          source: "SystemSculptPlugin",
        });
      }

      const debugMode = this.settings.debugMode ?? false;
      const logLevel = debugMode ? LogLevel.DEBUG : this.settings.logLevel ?? LogLevel.WARNING;
      setLogLevel(logLevel);
      errorLogger.setDebugMode(debugMode);

      logger.info("Settings initialized", {
        source: "SystemSculptPlugin",
        metadata: {
          logLevel,
          debugMode,
        },
      });

      phase.complete({
        logLevel,
        debugMode,
      });
    } catch (error) {
      const fallbackManager = this.ensureSettingsManagerInstance();
      if (!this._internal_settings_systemsculpt_plugin) {
        this._internal_settings_systemsculpt_plugin = fallbackManager.getSettings();
      }

      const fallbackSettings = this._internal_settings_systemsculpt_plugin;
      const debugMode = fallbackSettings?.debugMode ?? false;
      const logLevel = debugMode ? LogLevel.DEBUG : fallbackSettings?.logLevel ?? LogLevel.WARNING;
      setLogLevel(logLevel);
      errorLogger.setDebugMode(debugMode);

      this.failures.push("settings");
      phase.fail(error, {
        fallback: true,
      });

      logger.error("Failed to load settings, using defaults", error, {
        source: "SystemSculptPlugin",
        metadata: {
          logLevel,
          debugMode,
        },
      });
    }
  }

  private async initializeBasicServices() {
    const tracer = this.getInitializationTracer();
    const phase = tracer.startPhase("services.basic.initialize", {
      slowThresholdMs: 800,
      timeoutMs: 8000,
    });
    const logger = this.getLogger();

    try {
      this._aiService = SystemSculptService.getInstance(this);

      const metadata = {
        services: ["SystemSculptService"],
      };

      logger.info("Core AI services initialized", {
        source: "SystemSculptPlugin",
        metadata,
      });

      phase.complete(metadata);
    } catch (error) {
      this.failures.push("basic services");
      phase.fail(error, {
        services: ["SystemSculptService"],
      });

      logger.error("Failed to initialize core AI services", error, {
        source: "SystemSculptPlugin",
      });
    }
  }

  private async initializeBasicUI() {
    const tracer = this.getInitializationTracer();
    const phase = tracer.startPhase("ui.basic.initialize", {
      slowThresholdMs: 1000,
      timeoutMs: 9000,
    });

    if (this.isUnloading) {
      phase.complete({ skipped: true });
      return;
    }

    const logger = this.getLogger();

    try {
      this.ensureSettingsTab();

      if (!this.directoryManager) {
        this.directoryManager = new DirectoryManager(this.app, this);
      } else if (!this.directoryManager.isInitialized()) {
        await this.directoryManager.initialize();
      }

      if (this.isUnloading) {
        phase.complete({ skipped: true, stage: "post-directory-init" });
        return;
      }

      if (hasHostCapability("status-bar") && !this.embeddingsStatusBar) {
        this.embeddingsStatusBar = this.addChild(new EmbeddingsStatusBar(this));
      }

      logger.info("Primary UI components ready", {
        source: "SystemSculptPlugin",
      });

      phase.complete();
    } catch (error) {
      this.failures.push("UI components");
      phase.fail(error);

      logger.error("Failed to prepare primary UI", error, {
        source: "SystemSculptPlugin",
      });
    }
  }

  private ensureSettingsTab(): void {
    if (this.settingsTab) {
      return;
    }
    this.settingsTab = new SystemSculptSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
  }

  // DIRECTORY MANAGEMENT METHODS

  /**
   * Create a directory using the DirectoryManager
   * This is provided for backward compatibility with components
   * that haven't been updated to use the DirectoryManager directly
   */
  public async createDirectory(dirPath: string): Promise<void> {
    if (!this.directoryManager) {
      this.directoryManager = new DirectoryManager(this.app, this);
      await this.directoryManager.initialize();
    }

    await this.directoryManager.ensureDirectoryByPath(dirPath);
  }

  /**
   * For backward compatibility with existing components
   * Delegates to the createDirectory method
   */
  public async createDirectoryOnce(dirPath: string): Promise<void> {
    await this.createDirectory(dirPath);
  }

  /**
   * Repair the directory structure
   * For user-initiated repairs from settings or command palette
   */
  public async repairDirectoryStructure(): Promise<boolean> {
    if (!this.directoryManager) {
      this.directoryManager = new DirectoryManager(this.app, this);
    }

    const result = await this.directoryManager.repair();
    if (result) {
      this.showUserNotice("Directory structure has been repaired successfully.");
    } else {
      this.showUserNotice("Failed to repair directory structure. Check console for details.");
    }

    return result;
  }

  /**
   * Check the health of the directory structure
   * For diagnostics from settings
   */
  public async checkDirectoryHealth(): Promise<{valid: boolean, issues: string[]}> {
    if (!this.directoryManager) {
      this.directoryManager = new DirectoryManager(this.app, this);
    }

    return await this.directoryManager.verifyDirectories();
  }

  private async initializeRemainingServices() {
    const tracer = this.getInitializationTracer();
    const phase = tracer.startPhase("services.remaining.initialize", {
      slowThresholdMs: 4000,
      timeoutMs: 20000,
    });
    const logger = this.getLogger();
    const failures: string[] = [];

    try {
      if (this.criticalInitializationPromise) {
        logger.debug("Awaiting critical initialization before remaining services", {
          source: "SystemSculptPlugin",
        });
      }
      await this.waitForCriticalInitialization();
    } catch (error) {
      const failureError = error instanceof Error ? error : new Error(String(error ?? "critical initialization failed"));
      phase.fail(failureError, {
        skipped: true,
        reason: "critical-initialization-failed",
      });

      logger.warn("Remaining services skipped because critical initialization failed", {
        source: "SystemSculptPlugin",
        metadata: {
          error: failureError.message,
        },
      });

      throw failureError;
    }

    const wrap = <T>(key: string, displayName: string, action: () => T | Promise<T>): Promise<void> => {
      const subPhase = tracer.startPhase(`services.${key}`, {
        slowThresholdMs: 1500,
        timeoutMs: 10000,
        successLevel: "debug",
      });

      try {
        const result = action();
        if (result instanceof Promise) {
          return result
            .then(() => {
              subPhase.complete({ service: displayName });
            })
            .catch((error) => {
              subPhase.fail(error, { service: displayName });
              failures.push(displayName);
              logger.error(`Failed to initialize ${displayName}`, error, {
                source: "SystemSculptPlugin",
              });
            });
        }

        subPhase.complete({ service: displayName });
        return Promise.resolve();
      } catch (error) {
        subPhase.fail(error, { service: displayName });
        failures.push(displayName);
        logger.error(`Failed to initialize ${displayName}`, error, {
          source: "SystemSculptPlugin",
        });
        return Promise.resolve();
      }
    };

    await Promise.all([
      wrap("transcription", "transcription service", () => {
        this.transcriptionService = TranscriptionService.getInstance(this);
      }),
      wrap("fileContextMenu", "file context menu service", () => {
        this.setupFileContextMenuService();
      }),
      wrap("workflowEngine", "workflow engine service", () => {
        this.ensureWorkflowEngineService();
      }),
    ]);

    if (failures.length > 0) {
      this.failures.push(...failures);
    }

    phase.complete({
      failures: failures.length,
    });
  }

  private setupFileContextMenuService(forceRestart = false): void {
    if (this.fileContextMenuService && !forceRestart) {
      this.fileContextMenuService.start();
      return;
    }

    const { FileContextMenuService } = loadFileContextMenuServiceModule();
    this.fileContextMenuService = new FileContextMenuService({
      app: this.app,
      plugin: this,
      pluginLogger: this.pluginLogger,
    });

    this.pluginLogger?.info("File context menu integration ready", {
      source: "SystemSculptPlugin",
    });
  }

  public isPluginUnloading(): boolean {
    return this.isUnloading;
  }

  /**
   * Apply or remove the relative line number gutter across open editors to match
   * the current setting. Mutates the registered editor-extension array and calls
   * {@link Workspace.updateOptions} — the Obsidian-endorsed way to reconfigure
   * editor extensions live, so the toggle takes effect without a reload.
   */
  syncRelativeLineNumbersExtension(): void {
    const enabled = Boolean(this.settings.relativeLineNumbersEnabled);
    if (enabled === this.relativeLineNumbersApplied) {
      return;
    }

    this.relativeLineNumberExtensions.length = 0;
    if (enabled) {
      this.relativeLineNumberExtensions.push(relativeLineNumbersExtension());
    }
    this.relativeLineNumbersApplied = enabled;
    this.app.workspace.updateOptions();
  }

  private async initializeManagers() {
    if (this.managersInitialized) {
      return;
    }

    const inFlightInitialization = this.managersInitializationPromise;
    if (inFlightInitialization) {
      await inFlightInitialization;
      return;
    }

    const initialization = Promise.resolve()
      .then(() => this.performManagersInitialization())
      .finally(() => {
        if (this.managersInitializationPromise === initialization) {
          this.managersInitializationPromise = null;
        }
      });
    this.managersInitializationPromise = initialization;
    await initialization;
  }

  private ensureViewManager(): ViewManager {
    if (this.viewManager) {
      return this.viewManager;
    }

    const { ViewManager } = loadViewManagerModule();
    const viewManager = new ViewManager(this, this.app);
    viewManager.initialize();
    this.viewManager = viewManager;
    return this.viewManager;
  }

  private registerStudioExtensionsIfNeeded(): void {
    if (this.hasRegisteredStudioExtensions) {
      return;
    }

    this.registerExtensions(["systemsculpt"], SYSTEMSCULPT_STUDIO_VIEW_TYPE);
    this.hasRegisteredStudioExtensions = true;
  }

  private ensureCommandManager(): CommandManager {
    if (this.commandManager) {
      return this.commandManager;
    }

    const { CommandManager } = loadCommandManagerModule();
    const commandManager = new CommandManager(this, this.app);
    commandManager.registerCommands();
    this.commandManager = commandManager;
    return this.commandManager;
  }

  private async performManagersInitialization() {
    const tracer = this.getInitializationTracer();
    const phase = tracer.startPhase("managers.initialize", {
      slowThresholdMs: 4000,
      timeoutMs: 20000,
    });
    const logger = this.getLogger();

    try {
      if (!this.licenseManager) {
        this.licenseManager = new LicenseManager(this, this.app);
      }
      if (!this.resumeChatService) {
        this.resumeChatService = new ResumeChatService(this);
      }
      this.ensureViewManager();
      this.registerStudioExtensionsIfNeeded();
      this.ensureCommandManager();

      const metadata = {
        managers: [
          "LicenseManager",
          "ResumeChatService",
          "ViewManager",
          "CommandManager",
        ],
      };

      this.managersInitialized = true;

      logger.info("Managers initialized", {
        source: "SystemSculptPlugin",
        metadata,
      });

      phase.complete(metadata);
    } catch (error) {
      this.failures.push("managers");
      phase.fail(error);

      logger.error("Manager initialization failed", error, {
        source: "SystemSculptPlugin",
      });
    }
  }

  private async initializeLicense() {
    if (!this.licenseManager) {
      return;
    }

    const tracer = this.getInitializationTracer();
    const phase = tracer.startPhase("license.initialize", {
      slowThresholdMs: 4000,
      timeoutMs: 45000,
    });
    const logger = this.getLogger();

    try {
      await this.licenseManager.initializeLicense();
      phase.complete();

      logger.info("License validation completed", {
        source: "SystemSculptPlugin",
      });
    } catch (error) {
      this.failures.push("license validation");
      phase.fail(error);

      logger.warn("License validation failed", {
        source: "SystemSculptPlugin",
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  

  async onunload() {
    this.isUnloading = true;

    try {
      AudioTranscriptionPanel.disposeOwnedBy(this);
    } catch {
      // Stale transcription presentation must never block plugin teardown.
    }

    try {
      disposeMobileHostLayoutStates();
    } catch {
      // Host-layout observers are best-effort and must never block teardown.
    }

    // Halt self-rescheduling timers first and unconditionally (#214/#158): the
    // FreezeMonitor interval and PluginLogger flush timer never auto-clean, so
    // they must stop even if a later teardown step throws.
    try {
      FreezeMonitor.stop();
      this.pluginLogger?.dispose();
    } catch (error) {
      // Best-effort; teardown continues regardless.
    }

    // Microphone privacy is a first teardown priority. Keep this isolated from
    // the broader cleanup block so an unrelated service failure can never
    // leave capture running after the plugin is disabled.
    const recorder = this.recorderService;
    this.recorderService = null;
    try {
      recorder?.unload();
    } catch {
      // Recorder teardown is internally best-effort; continue plugin unload.
    }

    try {
      PostProcessingService.clearInstance(this);
    } catch {
      // Singleton teardown must never block the rest of plugin unload.
    }

    const tracer = this.getInitializationTracer();
    tracer.flushOpenPhases("plugin-unload");
    const phase = tracer.startPhase("plugin.onunload", {
      slowThresholdMs: 1000,
      timeoutMs: 10000,
    });
    const logger = this.getLogger();
    // Plugin unloading silently

    try {
      // Embeddings cleanup
      // Clean up error collector service
      if (this.errorCollectorService) {
        this.errorCollectorService.unload();
      }

      if (this.resourceMonitor) {
        this.resourceMonitor.stop();
        this.resourceMonitor = null;
      }

      if (this.pluginUpdateService) {
        this.pluginUpdateService.stop();
        this.pluginUpdateService = null;
      }

      // Clean up settings manager (stop automatic backups)
      if (this.settingsManager) {
        // Cleaning up settings manager silently
        this.settingsManager.destroy();
      }

      if (this.embeddingsStatusBar) {
        this.removeChild(this.embeddingsStatusBar);
        this.embeddingsStatusBar = null;
      }

      // Clean up embeddings manager
      if (this.embeddingsManager) {
        await this.embeddingsManager.cleanup();
        this.embeddingsManager = null;
      }

      if (this.workflowEngineService) {
        this.workflowEngineService.destroy();
        this.workflowEngineService = null;
      }

      if (this.searchEngine) {
        this.searchEngine.destroy();
        this.searchEngine = null;
      }

      if (this.studioService) {
        await this.studioService.dispose().catch(() => {});
        this.studioService = null;
      }

      // Cleanup UI components first
      if (this.settingsTab) {
        // Settings tab is automatically cleaned up by Obsidian
      }

      // Cleanup managers and views
      if (this.commandManager) {
        const commands = [
          "toggle-audio-recorder",
          "open-systemsculpt-chat",
          "open-systemsculpt-history",
          "open-systemsculpt-janitor",
          "reload-obsidian",
          "open-systemsculpt-settings",
          "chat-with-file",
          "suggest-edits",
          "clear-suggested-edits"
        ];
        commands.forEach((id) => {
          // @ts-ignore - removeCommand exists but isn't in the types
          this.app.commands.removeCommand(`${this.manifest.id}:${id}`);
        });
      }

      // Cleanup views
      if (this.viewManager) {
        this.viewManager.unloadViews();
      }

      if (this.fileContextMenuService) {
        this.fileContextMenuService.stop();
        this.fileContextMenuService = null;
      }

      this.managersInitialized = false;
      this.managersInitializationPromise = null;
      this.hasRegisteredStudioExtensions = false;

      // Embeddings manager already cleaned up above

      // Cleanup services in reverse order of initialization. Recorder cleanup
      // ran before every fallible teardown step above.
      if (this.transcriptionService) {
        this.transcriptionService.unload();
      }

      // Clean up resume chat service
      if (this.resumeChatService) {
        // Unloading resume chat service silently
        this.resumeChatService.cleanup();
      }

      // System prompts are now handled locally, no need to clear cache

      // Clean up vault file cache
      if (this.vaultFileCache) {
        // Destroying vault file cache silently
        this.vaultFileCache.destroy();
      }

      // Clear singleton instances and static caches
      SystemSculptService.clearInstance(); // Clear SystemSculptService singleton
      this.managedCapabilityGraph = null;
      
      // Clear service references without reassignment
      // @ts-ignore - Cleanup is handled by garbage collection
      this._aiService = undefined;

      // Plugin unloaded successfully silently
      // The logger's flush timer was already disposed at the top of onunload.
      this.pluginLogger = null;
      phase.complete();
      logger.info("SystemSculpt plugin unloaded", {
        source: "SystemSculptPlugin",
      });
    } catch (error) {
      phase.fail(error);
      logger.error("Plugin unload encountered errors", error, {
        source: "SystemSculptPlugin",
      });
    }

  }

  public get isReady(): boolean {
    return this.isPreloadingDone;
  }

  async loadData() {
    return super.loadData();
  }

  async saveData(data: any) {
    return super.saveData(data);
  }

  async saveSettings() {
    await this.settingsManager.saveSettings();
  }

  public getLogger(): PluginLogger {
    if (!this.pluginLogger) {
      this.pluginLogger = new PluginLogger(this, {
        logFileName: this.diagnosticsLogFileName,
      });
    } else {
      this.pluginLogger.setLogFileName(this.diagnosticsLogFileName);
    }
    return this.pluginLogger;
  }

  public getErrorCollector(): ErrorCollectorService | null {
    return this.errorCollectorService ?? null;
  }

  public getResourceMonitor(): ResourceMonitorService | null {
    return this.resourceMonitor;
  }

  public async openDiagnosticsFolder(): Promise<boolean> {
    if (!this.storage) {
      return false;
    }
    try {
      await this.storage.initialize();
    } catch {
      // Best effort; continue without blocking
    }
    const relativePath = this.storage.getPath("diagnostics");
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter && hasHostCapability("file-manager-reveal")) {
      const fullPath = adapter.getFullPath(relativePath);
      return openLocalFolder(fullPath);
    }
    return false;
  }

  public openSettingsTab(targetTab: string = "account"): void {
    const normalizedTargetTab = String(targetTab || "account").trim() || "account";
    this.pendingSettingsFocusTab = normalizedTargetTab;

    try {
      // @ts-ignore – Obsidian typings omit the settings API
      const settingsApi: any = this.app.setting;
      if (!settingsApi?.open || !settingsApi?.openTabById) {
        throw new Error("Settings API unavailable");
      }

      const focusPluginTab = (attempt: number = 0) => {
        const isSettingsModalOpen = !!document.querySelector(".modal.mod-settings");
        if (!isSettingsModalOpen) {
          if (attempt < 20) {
            window.setTimeout(() => focusPluginTab(attempt + 1), 50);
          }
          return;
        }

        const activeSettingsTabId = String(settingsApi?.activeTab?.id ?? "");
        if (activeSettingsTabId !== this.manifest.id) {
          try {
            settingsApi.openTabById(this.manifest.id);
          } catch {
            if (attempt < 20) {
              window.setTimeout(() => focusPluginTab(attempt + 1), 50);
            }
            return;
          }
        }

        const focusDelay = String(settingsApi?.activeTab?.id ?? "") === this.manifest.id ? 0 : 50;
        window.setTimeout(() => {
          this.app.workspace.trigger("systemsculpt:settings-focus-tab", normalizedTargetTab);
        }, focusDelay);
      };

      if (!document.querySelector(".modal.mod-settings")) {
        settingsApi.open();
      }
      focusPluginTab();
    } catch {
      new Notice("Open SystemSculpt AI settings to manage your account and plugin preferences.", 6000);
    }
  }

  public peekPendingSettingsFocusTab(): string | null {
    return this.pendingSettingsFocusTab;
  }

  public consumePendingSettingsFocusTab(): string | null {
    const pendingTab = this.pendingSettingsFocusTab;
    this.pendingSettingsFocusTab = null;
    return pendingTab;
  }

  public clearPendingSettingsFocusTab(targetTab?: string | null): void {
    if (targetTab && this.pendingSettingsFocusTab !== String(targetTab || "").trim()) {
      return;
    }
    this.pendingSettingsFocusTab = null;
  }

  public async openCreditsBalanceModal(options?: {
    initialBalance?: CreditsBalanceSnapshot | null;
    onBalanceUpdated?: (balance: CreditsBalanceSnapshot | null) => void | Promise<void>;
    settingsTab?: string;
  }): Promise<void> {
    const initialBalance = options?.initialBalance ?? null;
    let lastKnownBalance = initialBalance;
    const settingsTab = options?.settingsTab ?? "account";

    try {
      const { CreditsBalanceModal } = await import("./modals/CreditsBalanceModal");
      const modal = new CreditsBalanceModal(this.app, {
        initialBalance,
        fallbackPurchaseUrl: LICENSE_URL,
        loadBalance: async () => {
          try {
            const balance = await this.aiService.getCreditsBalance();
            lastKnownBalance = balance;
            if (options?.onBalanceUpdated) {
              await options.onBalanceUpdated(balance);
            }
            return balance;
          } catch {
            // Keep the last known snapshot on transient failures so the credits
            // indicator doesn't regress to an unknown state.
            return lastKnownBalance;
          }
        },
        loadUsage: (params) =>
          this.aiService.getCreditsUsage({
            limit: params?.limit,
            before: params?.before,
          }),
        onOpenSetup: () => this.openSettingsTab(settingsTab),
      });
      modal.open();
    } catch {
      // Fall back to settings if modal bootstrapping fails.
      this.openSettingsTab(settingsTab);
    }
  }

  hasRecorderService(): boolean {
    return this.recorderService !== null;
  }

  ensureRecorderService(): RecorderService {
    if (!this.recorderService) {
      const logger = this.getLogger();
      try {
        const { RecorderService } = loadRecorderServiceModule();
        const instance = RecorderService.getInstance(this.app, this);
        if (!instance) {
          throw new Error('RecorderService instance unavailable');
        }
        this.recorderService = instance;
        logger.debug('RecorderService instantiated', {
          source: 'RecorderService',
          metadata: { initializedDuringEnsure: true }
        });
      } catch (error) {
        logger.error('RecorderService initialization failed', error, {
          source: 'RecorderService',
          method: 'ensureRecorderService'
        });
        throw error;
      }
    }

    return this.recorderService;
  }

  getRecorderService(): RecorderService {
    return this.ensureRecorderService();
  }

  private ensureWorkflowEngineService(): WorkflowEngineService {
    if (!this.workflowEngineService) {
      this.workflowEngineService = new WorkflowEngineService(this);
      this.workflowEngineService.initialize();
    }

    return this.workflowEngineService;
  }

  getTranscriptionService(): TranscriptionService {
    return this.transcriptionService;
  }

  getLicenseManager(): LicenseManager {
    return this.licenseManager;
  }

  getSettingsManager(): SettingsManager {
    return this.settingsManager;
  }

  private async preloadDataInBackground() {
    const tracer = this.getInitializationTracer();
    const phase = tracer.startPhase("preload.background", {
      slowThresholdMs: 400,
      timeoutMs: 4000,
      successLevel: "debug",
    });
    const logger = this.getLogger();

    if (this.isUnloading) {
      phase.complete({ skipped: true });
      return;
    }

    this.isPreloadingDone = true;

    logger.debug("Background preload completed", {
      source: "SystemSculptPlugin",
    });

    phase.complete();
  }

  // Embeddings methods removed

  // --- Status bar methods removed ---

  // Embedding status polling methods removed

  /**
   * Public getter for the ViewManager instance.
   */
  getViewManager(): ViewManager {
    return this.ensureViewManager();
  }

  getStudioService(): StudioService {
    if (!this.studioService) {
      const { StudioService } = loadStudioServiceModule();
      this.studioService = new StudioService(this);
    }
    return this.studioService;
  }

  // --- Command Registration ---
  registerCommands() {

    this.addCommand({
      id: "systemsculpt-copy-resource-report",
      name: "Copy resource usage report",
      callback: async () => {
        const monitor = this.getResourceMonitor();
        if (!monitor) {
          new Notice("Resource monitor is still starting up.");
          return;
        }
        await monitor.captureManualSample("command");
        const { summary, path } = await monitor.exportSummaryReport();
        const copied = await tryCopyToClipboard(summary);
        if (copied) {
          new Notice("Resource report copied to clipboard.", 4000);
        } else if (path) {
          new Notice(`Resource report saved to ${path}.`, 5000);
        } else {
          new Notice("Unable to copy the report. See .systemsculpt/diagnostics.", 5000);
        }
      },
    });

    // Command: Find Similar Notes (Current Note)
    this.addCommand({
      id: 'find-similar-current-note',
      name: 'Find similar notes (current note)',
      editorCallback: async (editor, view) => {
        if (!view.file) {
          new Notice("No active file selected.");
          return;
        }

        const fileContent = editor.getValue();

        if (!fileContent.trim()) {
          new Notice("Current note is empty.");
          return;
        }

        try {
          // Check if embeddings are enabled
          if (!this.settings.embeddingsEnabled) {
            new Notice("Enable embeddings in SystemSculpt AI settings to find similar notes.");
            return;
          }

          // Activate embeddings view - processing happens automatically
          await this.getViewManager().activateEmbeddingsView();
        } catch (error) {
          new Notice(`Error finding similar notes: ${error.message}`);
        }
      },
    });
  }

}
