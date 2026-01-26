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
 * Version: 1.5.3
 */
import { Plugin, Notice, MarkdownView, setIcon, WorkspaceLeaf, debounce, TFile, FileSystemAdapter } from "obsidian";
import { initializeNotificationQueue } from "./core/ui/notifications";
import { SystemSculptSettings, DEFAULT_SETTINGS, LogLevel } from "./types";
import { SystemSculptModel } from "./types/llm";
import { SystemSculptService } from "./services/SystemSculptService";
import { SystemSculptSettingTab } from "./settings/SystemSculptSettingTab";
import { RecorderService } from "./services/RecorderService";
import { TranscriptionService } from "./services/TranscriptionService";
import { FileContextMenuService } from "./context-menu/FileContextMenuService";
import { SettingsManager } from "./core/settings/SettingsManager";
import { LicenseManager } from "./core/license/LicenseManager";
import { ViewManager } from "./core/plugin/views";
import { CommandManager } from "./core/plugin/commands";
import { CustomProviderService } from "./services/CustomProviderService";
import { setLogLevel } from "./utils/errorHandling";
import { errorLogger } from "./utils/errorLogger";
import { UnifiedModelService } from "./services/providers/UnifiedModelService";
import { TemplateManager } from "./templates/TemplateManager";
import { DirectoryManager } from "./core/DirectoryManager";
import { VersionCheckerService } from "./services/VersionCheckerService";
import { FavoritesService } from "./services/FavoritesService";
import { RuntimeIncompatibilityService } from "./services/RuntimeIncompatibilityService";
import { PreviewService } from './services/PreviewService';
import { StorageManager } from "./core/storage";
import { ResumeChatService } from "./views/chatview/ResumeChatService";
import { EmbeddingsManager } from "./services/embeddings/EmbeddingsManager";
import { VaultFileCache } from "./utils/VaultFileCache";
import { EmbeddingsStatusBar } from "./components/EmbeddingsStatusBar";
import { FreezeMonitor } from "./services/FreezeMonitor";
import { ResourceMonitorService } from "./services/ResourceMonitorService";
import { PerformanceDiagnosticsService, InstrumentOptions } from "./services/PerformanceDiagnosticsService";
import { PluginLogger } from "./utils/PluginLogger";
import { InitializationTracer } from "./core/diagnostics/InitializationTracer";
import { yieldToEventLoop } from "./utils/yieldToEventLoop";
import { PlatformContext } from "./services/PlatformContext";
import { tryCopyToClipboard } from "./utils/clipboard";
import { DailySettingsService, DailySettings } from "./services/daily/DailySettingsService";
import { DailyNoteService } from "./services/daily/DailyNoteService";
import { DailyWorkflowService } from "./services/daily/DailyWorkflowService";
import { DailyAnalyticsService } from "./services/daily/DailyAnalyticsService";
import { DailyReviewService } from "./services/daily/DailyReviewService";
import { DailyStatusBar } from "./components/daily/DailyStatusBar";
import { EventEmitter } from "./core/EventEmitter";
import { LifecycleCoordinator, LifecycleFailureEvent } from "./core/plugin/lifecycle/LifecycleCoordinator";
import { WorkflowEngineService } from "./services/workflow/WorkflowEngineService";
import { SystemSculptSearchEngine } from "./services/search/SystemSculptSearchEngine";
import { ReadwiseService } from "./services/readwise";
import { guardQuickEditEditorDiffLeaks, quickEditEditorDiffExtension } from "./quick-edit/editor-diff";

export default class SystemSculptPlugin extends Plugin {
  // Make internalSettings public but indicate it's for manager use only
  public _internal_settings_systemsculpt_plugin: SystemSculptSettings;
  // Keep the getter for general readonly access
  get settings(): SystemSculptSettings {
    return this._internal_settings_systemsculpt_plugin;
  }

  private _aiService: SystemSculptService | undefined;
  settingsTab: SystemSculptSettingTab;
  customProviderService: CustomProviderService;
  private recorderService: RecorderService | null = null;
  private transcriptionService: TranscriptionService;
  private settingsManager: SettingsManager;
  private licenseManager: LicenseManager;
  private viewManager: ViewManager;
  private commandManager: CommandManager;
  private fileContextMenuService: FileContextMenuService | null = null;
  private _modelService: UnifiedModelService | undefined;
  private templateManager: TemplateManager;
  private isUnloading = false;
  private isPreloadingDone = false;
  private failures: string[] = [];
  emitter: EventEmitter;
  directoryManager: DirectoryManager;
  public versionCheckerService: VersionCheckerService;
  private errorCollectorService: ErrorCollectorService;
  private favoritesService: FavoritesService;
  public resumeChatService: ResumeChatService;
  private statusBarEl: HTMLElement | null = null;
  private statusIconEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private _lastActiveFile: { path: string; content: string; timestamp: number } | null = null;
  public storage: StorageManager;
  private pluginLogger: PluginLogger | null = null;
  private initializationTracer: InitializationTracer | null = null;
  public hasPromptedForDefaultModel = false;
  public embeddingsManager: EmbeddingsManager | null = null;
  public vaultFileCache: VaultFileCache;
  public embeddingsStatusBar: EmbeddingsStatusBar | null = null;
  private resourceMonitor: ResourceMonitorService | null = null;
  private performanceDiagnostics: PerformanceDiagnosticsService | null = null;
  private lifecycleCoordinator: LifecycleCoordinator | null = null;
  private diagnosticsSessionId: string | null = null;
  private diagnosticsLogFileName = "systemsculpt-latest.log";
  private diagnosticsMetricsFileName = "resource-metrics-latest.ndjson";
  private diagnosticsOperationsFileName = "operations-latest.ndjson";
  private workflowEngineService: WorkflowEngineService | null = null;
  private searchEngine: SystemSculptSearchEngine | null = null;
  // Removed complex settings callback system - embeddings are now completely on-demand

  // Daily vault system services
  private dailySettingsService: DailySettingsService | null = null;
  private dailyNoteService: DailyNoteService | null = null;
  private dailyWorkflowService: DailyWorkflowService | null = null;
  private dailyAnalyticsService: DailyAnalyticsService | null = null;
  private dailyStatusBar: DailyStatusBar | null = null;
  private dailyStatusBarItem: HTMLElement | null = null;
  private dailyReviewService: DailyReviewService | null = null;

  // Readwise integration
  private readwiseService: ReadwiseService | null = null;

  // Simple initialization tracking
  private embeddingsInitialized = false;

  private criticalInitializationPromise: Promise<void> | null = null;
  private deferredInitializationPromise: Promise<void> | null = null;
  
  // Lazy service getters to avoid blocking startup
  public get aiService(): SystemSculptService {
    if (!this._aiService) {
      if (!this.customProviderService) {
        this.customProviderService = new CustomProviderService(this, this.app);
      }
      this._aiService = SystemSculptService.getInstance(this);
      this.instrumentServiceInstance(this._aiService, "SystemSculptService");
    }
    return this._aiService;
  }

  public get modelService(): UnifiedModelService {
    if (!this._modelService) {
      this._modelService = UnifiedModelService.getInstance(this);
      this.instrumentServiceInstance(this._modelService, "UnifiedModelService");
    }
    return this._modelService;
  }
  
  /**
   * Get or create embeddings manager - simple and reliable
   */
  public getOrCreateEmbeddingsManager(): EmbeddingsManager {
    if (!this.embeddingsManager) {
      // Validate prerequisites based on provider
      const provider = (this.settings as any).embeddingsProvider || "systemsculpt";
      if (provider === 'systemsculpt') {
        const hasLicenseKey = !!this.settings.licenseKey?.trim();
        const hasValidLicense = this.settings.licenseValid === true;
        if (!hasLicenseKey || !hasValidLicense) {
          throw new Error('Embeddings require an active SystemSculpt license. Validate your license in settings.');
        }
        if (!this.settings.serverUrl) {
          throw new Error('Embeddings not available. Please verify your SystemSculpt server URL in settings.');
        }
      } else if (provider === 'custom') {
        // For custom provider, do not require SystemSculpt license or server URL here
        const endpoint = (this.settings.embeddingsCustomEndpoint || '').trim();
        const model = (this.settings.embeddingsCustomModel || this.settings.embeddingsModel || '').trim();
        if (!endpoint || !model) {
          throw new Error('Custom embeddings provider is not configured. Set API Endpoint and Model in settings.');
        }
      } else {
        throw new Error(
          `Unknown embeddings provider: ${String(provider)}. Open SystemSculpt → Settings → Embeddings and select "SystemSculpt" or "Custom provider".`
        );
      }

      this.embeddingsManager = new EmbeddingsManager(this.app, this);
      this.instrumentServiceInstance(this.embeddingsManager, "EmbeddingsManager");

      // Initialize in background if not already done
      if (!this.embeddingsInitialized) {
        this.embeddingsInitialized = true;
        this.embeddingsManager
          .initialize()
          .catch((error) => {
            const logger = this.getLogger();
            logger.error("Embeddings manager background initialization failed", error, {
              source: "SystemSculptPlugin",
              metadata: {
                provider,
              },
            });
          });
      }
    }

    return this.embeddingsManager;
  }

  public getSearchEngine(): SystemSculptSearchEngine {
    if (!this.searchEngine) {
      this.searchEngine = new SystemSculptSearchEngine(this.app, this);
    }
    return this.searchEngine;
  }


  public getPluginLogger(): PluginLogger | null {
    return this.pluginLogger;
  }

  public getDailySettingsService(): DailySettingsService {
    if (!this.dailySettingsService) {
      this.dailySettingsService = new DailySettingsService(this.app);
      this.instrumentServiceInstance(this.dailySettingsService, "DailySettingsService");
      this.dailySettingsService.initialize().then(async () => {
        const settings = await this.dailySettingsService!.getSettings();
        await this.onDailySettingsUpdated(settings);
      }).catch((error) => {
        const logger = this.getLogger();
        logger.error("Daily settings service initialization failed", error, {
          source: "SystemSculptPlugin",
        });
      });
      this.dailySettingsService.onSettingsChange((settings) => {
        void this.onDailySettingsUpdated(settings);
      });
    }
    return this.dailySettingsService;
  }

  public getDailyNoteService(): DailyNoteService {
    if (!this.dailyNoteService) {
      const eventBus = new EventEmitter();
      this.dailyNoteService = new DailyNoteService(
        this.app,
        this.getDailySettingsService(),
        eventBus
      );
      this.instrumentServiceInstance(this.dailyNoteService, "DailyNoteService");
    }
    return this.dailyNoteService;
  }

  public getDailyWorkflowService(): DailyWorkflowService {
    if (!this.dailyWorkflowService) {
      const logger = this.getLogger();
      this.dailyWorkflowService = new DailyWorkflowService(
        this.getDailyNoteService(),
        this.getDailySettingsService()
      );
      this.instrumentServiceInstance(this.dailyWorkflowService, "DailyWorkflowService");
      this.dailyWorkflowService.initialize().catch((error) => {
        logger.warn("Daily workflow service failed to initialize", {
          source: "SystemSculptPlugin",
          metadata: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
    }
    return this.dailyWorkflowService;
  }

  public getDailyAnalyticsService(): DailyAnalyticsService {
    if (!this.dailyAnalyticsService) {
      this.dailyAnalyticsService = new DailyAnalyticsService(this.getDailyNoteService());
      this.instrumentServiceInstance(this.dailyAnalyticsService, "DailyAnalyticsService");
    }
    return this.dailyAnalyticsService;
  }

  public getDailyReviewService(): DailyReviewService {
    if (!this.dailyReviewService) {
      this.dailyReviewService = new DailyReviewService(
        this.app,
        this.getDailyNoteService(),
        this.getDailySettingsService()
      );
      this.instrumentServiceInstance(this.dailyReviewService, "DailyReviewService");
    }
    return this.dailyReviewService;
  }

  /**
   * Get or create the Readwise service for importing highlights
   */
  public getReadwiseService(): ReadwiseService {
    if (!this.readwiseService) {
      this.readwiseService = new ReadwiseService(this);
      this.instrumentServiceInstance(this.readwiseService, "ReadwiseService");
      // Initialize the service (loads sync state, starts scheduled sync if configured)
      this.readwiseService.initialize().catch((error) => {
        const logger = this.getLogger();
        logger.warn("Readwise service failed to initialize", {
          source: "SystemSculptPlugin",
          metadata: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
    }
    return this.readwiseService;
  }

  private async onDailySettingsUpdated(settings: DailySettings): Promise<void> {
    if (settings.showDailyStatusBar) {
      await this.ensureDailyStatusBar(settings);
    } else {
      this.disposeDailyStatusBar();
    }

    // Ensure workflow service is running to respond to new settings
    this.getDailyWorkflowService();
  }

  private async ensureDailyStatusBar(settingsOverride?: DailySettings): Promise<void> {
    const settings = settingsOverride || await this.getDailySettingsService().getSettings();
    if (!settings.showDailyStatusBar) {
      return;
    }

    if (!this.dailyStatusBarItem) {
      this.dailyStatusBarItem = this.addStatusBarItem();
    }

		if (!this.dailyStatusBar) {
			this.dailyStatusBar = new DailyStatusBar(
				this.app,
				this.getDailyNoteService(),
				this.getDailySettingsService()
			);
	      this.instrumentServiceInstance(this.dailyStatusBar, "DailyStatusBar", {
	        includePrefixes: ["render", "refresh", "request", "open"],
	      });
      await this.dailyStatusBar.initialize(this.dailyStatusBarItem);
    } else {
      this.dailyStatusBar.requestRefresh(true);
    }

    this.dailyStatusBar?.requestRefresh();
  }

  private disposeDailyStatusBar(): void {
    if (this.dailyStatusBar) {
      this.dailyStatusBar.cleanup();
      this.dailyStatusBar = null;
    }

    if (this.dailyStatusBarItem) {
      this.dailyStatusBarItem.remove();
      this.dailyStatusBarItem = null;
    }
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

  private runAfterIdleAsync<T>(task: () => Promise<T>, timeoutMs: number = 300): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const idle =
        typeof window !== "undefined" && typeof (window as any).requestIdleCallback === "function"
          ? (window as any).requestIdleCallback
          : null;

      const runner = () => {
        task().then(resolve).catch(reject);
      };

      if (idle) {
        idle(() => runner(), { timeout: timeoutMs });
      } else if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
        window.setTimeout(runner, timeoutMs);
      } else {
        setTimeout(runner, timeoutMs);
      }
    });
  }



  private lastFileCountUpdate = 0;
  private fileCountCacheInterval = 60000; // Update cache every 60 seconds
  
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
    await this.rotateDiagnosticsFile(this.diagnosticsOperationsFileName, `operations-${timestamp}.ndjson`);

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

  private instrumentServiceInstance(instance: unknown, moduleName: string, options?: InstrumentOptions) {
    if (!instance) return;
    this.performanceDiagnostics?.instrumentObject(instance, moduleName, options);
  }

  private wrapCommandCallback<T extends (...args: any[]) => any>(name: string, fn: T): T {
    if (!this.performanceDiagnostics) {
      return fn;
    }
    return this.performanceDiagnostics.profileFunction(fn, "Command", name);
  }



  async onload() {
    const loadStart = performance.now();
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
      },
    });

    try {
      this.configureLifecycle(loadStart);
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
    }

    if (this.failures.length > 0) {
      logger.warn("Initialization reported recoverable issues", {
        source: "SystemSculptPlugin",
        metadata: {
          failures: [...this.failures],
        },
      });
      this.showErrorNotice(
        `SystemSculpt had issues with: ${this.failures.join(", ")}. Some features may be unavailable.`,
        this.collectErrorDetails()
      );
    }
  }

  private configureLifecycle(loadStart: number): void {
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
    const logger = this.getLogger();

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
        this.registerEditorExtension(quickEditEditorDiffExtension);
        this.registerEvent(
          this.app.workspace.on("file-open", () => {
            guardQuickEditEditorDiffLeaks(this.app);
          })
        );

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
            const filePath =
              leaf && leaf.view instanceof MarkdownView && leaf.view.file ? leaf.view.file.path : null;

            FreezeMonitor.mark("workspace:active-leaf-change:start", { hasLeaf: !!leaf });
            if (filePath) {
              this._lastActiveFile = {
                path: filePath,
                content: "",
                timestamp: Date.now(),
              };
            }
          })
        );

        this.registerEvent(
          this.app.workspace.on("systemsculpt:settings-updated", (_oldSettings, _newSettings) => {
            try {
              this.embeddingsManager?.syncFromSettings();
            } catch (error) {
              const logger = this.getLogger();
              logger.error("Embeddings manager settings sync failed", error, {
                source: "SystemSculptPlugin",
              });
            }
          })
        );
      },
    });

    coordinator.registerTask("bootstrap", {
      id: "notifications.initialize",
      label: "notification queue",
      optional: true,
      run: () => {
        initializeNotificationQueue(this.app);
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
      id: "services.versionChecker",
      label: "version checker",
      run: () => {
        const version = this.manifest.version;
        this.versionCheckerService = VersionCheckerService.getInstance(version, this.app, this);
        this.instrumentServiceInstance(this.versionCheckerService, "VersionCheckerService", {
          includePrefixes: ["check", "start", "show"],
        });
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
      id: "monitor.performance",
      label: "performance diagnostics",
      optional: true,
      run: () => {
        this.performanceDiagnostics = new PerformanceDiagnosticsService(this, {
          operationsFileName: this.diagnosticsOperationsFileName,
          sessionId: this.diagnosticsSessionId ?? undefined,
          blockedModules: ["StorageManager"],
        });
        this.performanceDiagnostics.instrumentPluginLifecycle(this);
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
      id: "updates.schedule",
      label: "version check",
      optional: true,
      diagnostics: {
        slowThresholdMs: 30_000,
        timeoutMs: 120_000,
      },
      run: async () => {
        if (!this.versionCheckerService) {
          return;
        }

        const tracer = this.getInitializationTracer();
        const scheduleDelayMs = 10000;
        const schedulePhase = tracer.startPhase("updates.check.schedule", {
          slowThresholdMs: 0,
          timeoutMs: 0,
          successLevel: "debug",
          metadata: {
            intent: "version-check",
          },
        });
        schedulePhase.complete({
          scheduledDelayMs: scheduleDelayMs,
        });

        await new Promise<void>((resolve) => {
          const timer = typeof window !== "undefined" && typeof window.setTimeout === "function" ? window.setTimeout : setTimeout;
          timer(() => {
            const executePhase = tracer.startPhase("updates.check.execute", {
              slowThresholdMs: 6000,
              timeoutMs: 30000,
              successLevel: "debug",
            });

            const service = this.versionCheckerService;

            if (!service) {
              executePhase.complete({
                skipped: true,
                reason: "service-unavailable",
              });
              resolve();
              return;
            }

            const profiledRunner = this.performanceDiagnostics
              ? this.performanceDiagnostics.profileFunction(
                  service.checkForUpdatesOnStartup.bind(service),
                  "VersionCheckerService",
                  "checkForUpdatesOnStartup"
                )
              : service.checkForUpdatesOnStartup.bind(service);

            this.runAfterIdleAsync(() => profiledRunner(0), 750)
              .then(() => {
                executePhase.complete();
                resolve();
              })
              .catch((error) => {
                executePhase.fail(error);
                resolve();
              });
          }, scheduleDelayMs);
        });
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
        if (!this.settings.embeddingsEnabled || !this.settings.embeddingsAutoProcess) {
          return;
        }

        const tracer = this.getInitializationTracer();
        await new Promise<void>((resolve) => {
          const timer = typeof window !== "undefined" && typeof window.setTimeout === "function" ? window.setTimeout : setTimeout;
          timer(() => {
            const embeddingsPhase = tracer.startPhase("embeddings.autostart", {
              slowThresholdMs: 8000,
              timeoutMs: 60000,
            });
            try {
              this.getOrCreateEmbeddingsManager();
              embeddingsPhase.complete();
            } catch (error) {
              embeddingsPhase.fail(error);
            }
            resolve();
          }, 10000);
        });
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
        throw failureError;
      });

    this.deferredInitializationPromise = this.criticalInitializationPromise.then(async () => {
      await yieldToEventLoop();
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
      throw failureError;
    });
  }

  private bootstrapPostCriticalServices(tracer: InitializationTracer, logger: PluginLogger): void {
    this.waitForCriticalInitialization()
      .then(() => {
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

  /**
   * Show an error notice with copy functionality
   * @param message The error message to display
   * @param details Additional error details to include when copied
   */
  private showErrorNotice(message: string, details: string) {
    // Create a notice with text and a button
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
    details.push(`- Template Manager: ${!!this.templateManager}`);

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
    if (this.performanceDiagnostics) {
      lines.push("");
      const hotspots = this.performanceDiagnostics.getHotspots(Math.max(3, Math.min(5, resourceLines)));
      lines.push("Top plugin hotspots:");
      if (hotspots.length === 0) {
        lines.push("No profiled hotspots yet. Interact with the plugin to gather traces.");
      } else {
        hotspots.forEach((stat, index) => {
          const avg = stat.count > 0 ? stat.totalDuration / stat.count : 0;
          const avgMem = stat.count > 0 ? stat.totalMemoryDelta / stat.count : 0;
          lines.push(
            `${index + 1}. ${stat.module}.${stat.name} — avg ${avg.toFixed(2)}ms, avg Δ ${(avgMem / 1024 / 1024).toFixed(
              3
            )} MB`
          );
        });
      }
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

  public async exportPerformanceHotspots(limit: number = 10): Promise<{ text: string; path?: string }> {
    if (!this.performanceDiagnostics) {
      return { text: "Performance diagnostics service is not running yet." };
    }
    return this.performanceDiagnostics.exportHotspotReport(limit);
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
      this.instrumentServiceInstance(this.directoryManager, "DirectoryManager");
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
      this.instrumentServiceInstance(this.vaultFileCache, "VaultFileCache");
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

      void this.initializeLicense();

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

  /**
   * Initialize embeddings for user - fully automatic
   */
  public async initializeEmbeddingsForUser(): Promise<void> {
    try {
      const manager = this.getOrCreateEmbeddingsManager();

      // Status bar disabled – no monitoring

      // Everything else is automatic - no manual processing needed
    } catch (error) {
      throw error;
    }
  }

  /**
   * Initialize embeddings - simple system doesn't need file monitoring
   */
  public async initializeEmbeddingsForFileEvents(): Promise<void> {
    // Embeddings process on demand with automatic file monitoring
  }

  /**
   * Set up file watchers for embeddings system
   */
  private setupEmbeddingsFileWatchers(): void {
    // Embeddings system handles reindexing automatically
    // Embeddings uses on-demand processing silently
  }

  /**
   * Auto-start embeddings processing - simplified
   */
  private async autoStartEmbeddingsProcessing(): Promise<void> {
    // Auto-processing handled internally by embeddings manager
    // Processing happens on-demand when needed
  }

  private ensureSettingsManagerInstance(): SettingsManager {
    if (!this.settingsManager) {
      this.settingsManager = new SettingsManager(this);
      this.instrumentServiceInstance(this.settingsManager, "SettingsManager", {
        includePrefixes: ["load", "save", "update", "ensure"],
      });
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
        const { StandardModelSelectionModal } = await import("./modals/StandardModelSelectionModal");
        StandardModelSelectionModal.cleanupProviderPreferences(this);
      } catch (cleanupError) {
        logger.debug("No standard model preference cleanup needed", {
          source: "SystemSculptPlugin",
          metadata: {
            message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          },
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
      this.customProviderService = new CustomProviderService(this, this.app);
      this.instrumentServiceInstance(this.customProviderService, "CustomProviderService");
      this._aiService = SystemSculptService.getInstance(this);
      this.instrumentServiceInstance(this._aiService, "SystemSculptService");
      this.favoritesService = FavoritesService.getInstance(this);
      this.instrumentServiceInstance(this.favoritesService, "FavoritesService");
      // Initialize runtime incompatibility tracking (persists model tool/image rejections)
      RuntimeIncompatibilityService.getInstance(this);
      this._modelService = UnifiedModelService.getInstance(this);
      this.instrumentServiceInstance(this._modelService, "UnifiedModelService");

      const metadata = {
        services: [
          "CustomProviderService",
          "SystemSculptService",
          "FavoritesService",
          "RuntimeIncompatibilityService",
          "UnifiedModelService",
        ],
      };

      logger.info("Core AI services initialized", {
        source: "SystemSculptPlugin",
        metadata,
      });

      phase.complete(metadata);
    } catch (error) {
      this.failures.push("basic services");
      phase.fail(error, {
        services: [
          "CustomProviderService",
          "SystemSculptService",
          "FavoritesService",
          "UnifiedModelService",
        ],
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
    const logger = this.getLogger();

    try {
      this.ensureSettingsTab();

      if (!this.directoryManager) {
        await this.initializeDirectories();
      } else if (!this.directoryManager.isInitialized()) {
        await this.directoryManager.initialize();
      }

      this.templateManager = new TemplateManager(this, this.app);
      this.instrumentServiceInstance(this.templateManager, "TemplateManager");

      if (!this.embeddingsStatusBar) {
        this.embeddingsStatusBar = new EmbeddingsStatusBar(this);
        this.register(() => {
          this.embeddingsStatusBar?.unload();
          this.embeddingsStatusBar = null;
        });
      }

      this.getDailyWorkflowService();
      await this.ensureDailyStatusBar();

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
      wrap("recorder", "recorder service", () => {
        this.ensureRecorderService();
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

    this.fileContextMenuService = new FileContextMenuService({
      app: this.app,
      plugin: this,
      pluginLogger: this.pluginLogger,
    });

    this.pluginLogger?.info("File context menu integration ready", {
      source: "SystemSculptPlugin",
    });
  }

  private async initializeManagers() {
    const tracer = this.getInitializationTracer();
    const phase = tracer.startPhase("managers.initialize", {
      slowThresholdMs: 4000,
      timeoutMs: 20000,
    });
    const logger = this.getLogger();

    try {
      this.licenseManager = new LicenseManager(this, this.app);
      this.instrumentServiceInstance(this.licenseManager, "LicenseManager");
      this.resumeChatService = new ResumeChatService(this);
      this.instrumentServiceInstance(this.resumeChatService, "ResumeChatService");
      this.viewManager = new ViewManager(this, this.app);
      this.instrumentServiceInstance(this.viewManager, "ViewManager");
      this.viewManager.initialize();
      this.commandManager = new CommandManager(this, this.app);
      this.instrumentServiceInstance(this.commandManager, "CommandManager");
      this.commandManager.registerCommands();

      const metadata = {
        managers: [
          "LicenseManager",
          "ResumeChatService",
          "ViewManager",
          "CommandManager",
        ],
      };

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
      // Clean up version checker service
      if (this.versionCheckerService) {
        VersionCheckerService.clearInstance();
      }

      // Clean up error collector service
      if (this.errorCollectorService) {
        this.errorCollectorService.unload();
      }

      if (this.resourceMonitor) {
        this.resourceMonitor.stop();
        this.resourceMonitor = null;
      }
      this.performanceDiagnostics = null;

      // Clean up settings manager (stop automatic backups)
      if (this.settingsManager) {
        // Cleaning up settings manager silently
        this.settingsManager.destroy();
      }

      // Clean up embeddings manager
      if (this.embeddingsManager) {
        this.embeddingsManager.cleanup();
        this.embeddingsManager = null;
      }

      if (this.embeddingsStatusBar) {
        this.embeddingsStatusBar.unload();
        this.embeddingsStatusBar = null;
      }

      if (this.dailyWorkflowService) {
        this.dailyWorkflowService.cleanup();
        this.dailyWorkflowService = null;
      }

      this.disposeDailyStatusBar();

      if (this.workflowEngineService) {
        this.workflowEngineService.destroy();
        this.workflowEngineService = null;
      }

      if (this.searchEngine) {
        this.searchEngine.destroy();
        this.searchEngine = null;
      }

      // Cleanup Readwise service
      if (this.readwiseService) {
        this.readwiseService.destroy();
        this.readwiseService = null;
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
          "open-chat-history",
          "open-systemsculpt-janitor",
          "reload-obsidian",
          "open-systemsculpt-settings",
          "change-chat-model",
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

      // Cleanup template manager
      if (this.templateManager) {
        this.templateManager.unload();
      }

      if (this.fileContextMenuService) {
        this.fileContextMenuService.stop();
        this.fileContextMenuService = null;
      }

      // Embeddings manager already cleaned up above

      // Cleanup services in reverse order of initialization
      if (this.recorderService) {
        // Unloading recorder service silently
        this.recorderService.unload();
        this.recorderService = null;
      }
      if (this.transcriptionService) {
        this.transcriptionService.unload();
      }

      // Clean up resume chat service
      if (this.resumeChatService) {
        // Unloading resume chat service silently
        this.resumeChatService.cleanup();
      }

      // System prompts are now handled locally, no need to clear cache

      // Clean up embeddings manager
      if (this.embeddingsManager) {
        // Cleaning up embeddings manager silently
        this.embeddingsManager = null;
      }
      
      // Clean up vault file cache
      if (this.vaultFileCache) {
        // Destroying vault file cache silently
        this.vaultFileCache.destroy();
      }

      // Clear singleton instances and static caches
      UnifiedModelService.clearInstance(); // Clear the new unified service
      FavoritesService.clearInstance();
      RuntimeIncompatibilityService.clearInstance();
      SystemSculptService.clearInstance(); // Clear SystemSculptService singleton
      CustomProviderService.clearStaticCaches();
      
      // Clear service references without reassignment
      // @ts-ignore - Cleanup is handled by garbage collection
      this._modelService = undefined;
      // @ts-ignore - Cleanup is handled by garbage collection
      this._aiService = undefined;
      // @ts-ignore - Cleanup is handled by garbage collection
      this.customProviderService = undefined;

      // Clean up the PreviewService
      try {
        // Cleaning up PreviewService silently
        PreviewService.hideAllPreviews();
        PreviewService.cleanup();
      } catch (error) {
      }

      // Clean up status bar elements
      try {
        if (this.statusBarEl) {
          this.statusBarEl.remove();
          this.statusBarEl = null;
          this.statusIconEl = null;
          this.statusTextEl = null;
          this.progressEl = null;
        }
      } catch (error) {
      }


      // Plugin unloaded successfully silently
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
    if (adapter instanceof FileSystemAdapter) {
      const fullPath = adapter.getFullPath(relativePath);
      const electron = typeof window !== "undefined" ? (window as any)?.require?.("electron") : null;
      const shell = electron?.shell;
      if (shell?.openPath) {
        await shell.openPath(fullPath);
        return true;
      }
      if (shell?.openExternal) {
        await shell.openExternal(`file://${fullPath}`);
        return true;
      }
    }
    return false;
  }

  hasRecorderService(): boolean {
    return this.recorderService !== null;
  }

  ensureRecorderService(): RecorderService {
    if (!this.recorderService) {
      const logger = this.getLogger();
      try {
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
      this.instrumentServiceInstance(this.workflowEngineService, "WorkflowEngineService", {
        includePrefixes: ["initialize", "handle", "maybe", "persist"],
      });
      this.workflowEngineService.initialize();
    }

    return this.workflowEngineService;
  }

  getTranscriptionService(): TranscriptionService {
    return this.transcriptionService;
  }

  public async runAutomationOnFile(
    automationId: string,
    file: TFile,
    options?: { onStatus?: (status: string, progress?: number) => void }
  ): Promise<TFile | null> {
    const engine = this.ensureWorkflowEngineService();
    return await engine.runAutomationOnFile(automationId, file, options);
  }

  public async getAutomationBacklog() {
    const engine = this.ensureWorkflowEngineService();
    return await engine.getAutomationBacklog();
  }

  getLicenseManager(): LicenseManager {
    return this.licenseManager;
  }

  getSettingsManager(): SettingsManager {
    return this.settingsManager;
  }

  /**
   * Get fresh models from the model service
   */
  public getInitialModels(): Promise<SystemSculptModel[]> {
    return this.modelService.getModels();
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

    // Best-effort warmup so changelog works offline and avoids repeated GitHub calls.
    void import("./services/ChangeLogService")
      .then(({ ChangeLogService }) => ChangeLogService.warmCache(this))
      .catch(() => {});

    logger.debug("Background preload completed", {
      source: "SystemSculptPlugin",
    });

    phase.complete();
  }

  // Add getter for version checker service
  public getVersionCheckerService(): VersionCheckerService {
    return this.versionCheckerService;
  }

  public async updateLastSaveAsNoteFolder(folder: string) {
    await this.settingsManager.updateSettings({ lastSaveAsNoteFolder: folder });
  }

  // Embeddings methods removed

  // --- Status bar methods removed ---

  // Embedding status polling methods removed

  /**
   * Public getter for the ViewManager instance.
   */
  getViewManager(): ViewManager {
      if (!this.viewManager) {
      }
      return this.viewManager;
  }

  // --- Command Registration ---
  registerCommands() {

    this.addCommand({
      id: "systemsculpt-copy-resource-report",
      name: "Copy Resource Usage Report",
      callback: this.wrapCommandCallback("copy-resource-report", async () => {
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
      }),
    });

    this.addCommand({
      id: "systemsculpt-copy-performance-hotspots",
      name: "Copy Performance Hotspots",
      callback: this.wrapCommandCallback("copy-performance-hotspots", async () => {
        const { text, path } = await this.exportPerformanceHotspots();
        const copied = await tryCopyToClipboard(text);
        if (copied) {
          new Notice("Performance hotspots copied to clipboard.", 4000);
        } else if (path) {
          new Notice(`Performance hotspots saved to ${path}.`, 5000);
        } else {
          new Notice("Unable to copy performance report. See .systemsculpt/diagnostics.", 5000);
        }
      }),
    });

    // Command: Audio Chunking Analysis
    this.addCommand({
      id: 'audio-chunking-analysis',
      name: 'Run Audio Chunking Analysis',
      callback: this.wrapCommandCallback('audio-chunking-analysis', () => {
        // Import and run the analysis
        import("./commands/RunAudioAnalysis").then(module => {
          module.runAudioAnalysis(this);
        }).catch(error => {
          new Notice(`Error running analysis: ${error instanceof Error ? error.message : String(error)}`);
        });
      })
    });

    // Command: Find Similar Notes (Current Note)
    this.addCommand({
      id: 'find-similar-current-note',
      name: 'Find Similar Notes (Current Note)',
      editorCallback: this.wrapCommandCallback('find-similar-current-note', async (editor, view) => {
        if (!view.file) {
          new Notice("No active file selected.");
          return;
        }

        const currentFilePath = view.file.path;
        const fileContent = editor.getValue();

        if (!fileContent.trim()) {
          new Notice("Current note is empty.");
          return;
        }

        try {
          // Check if embeddings are enabled
          if (!this.settings.embeddingsEnabled) {
            new Notice("Enable embeddings in Settings > SystemSculpt AI > Embeddings to find similar notes.");
            return;
          }

          // Activate embeddings view - processing happens automatically
          await this.viewManager.activateEmbeddingsView();
        } catch (error) {
          new Notice(`Error finding similar notes: ${error.message}`);
        }
      }),
    });


    

    // Command: Process Embeddings
    this.addCommand({
      id: 'process-embeddings',
      name: 'Process Embeddings',
      callback: this.wrapCommandCallback('process-embeddings', async () => {
        try {
          if (!this.settings.embeddingsEnabled) {
            new Notice("Embeddings are disabled. Enable them in Settings > SystemSculpt AI > Embeddings.");
            return;
          }

          // Embeddings are now fully automatic - no manual processing needed
          new Notice("Embeddings processing is automatic. Files are processed in the background as needed.");
        } catch (error) {
          new Notice(`Failed to process embeddings: ${error.message}`);
        }
      }),
    });

    // Command: Rebuild Embeddings
    this.addCommand({
      id: 'rebuild-embeddings',
      name: 'Rebuild Embeddings',
      callback: this.wrapCommandCallback('rebuild-embeddings', async () => {
        try {
          if (!this.settings.embeddingsEnabled) {
            new Notice("Embeddings are disabled. Enable them in Settings > SystemSculpt AI > Embeddings.");
            return;
          }

          const manager = this.getOrCreateEmbeddingsManager();

          new Notice("Clearing embeddings data...");
          await manager.clearAll();

          new Notice("Embeddings cleared. Files will be automatically re-processed in the background.");
        } catch (error) {
          new Notice(`Failed to rebuild embeddings: ${error.message}`);
        }
      }),
    });

    this.addCommand({
      id: 'toggle-mobile-emulation',
      name: 'Toggle Mobile Emulation Mode',
      callback: this.wrapCommandCallback('toggle-mobile-emulation', () => {
        const appAny = this.app as any;
        if (typeof appAny.emulateMobile !== 'function') {
          new Notice('Mobile emulation is not available in this Obsidian build.', 4000);
          return;
        }

        const nextState = !appAny.isMobile;
        try {
          appAny.emulateMobile(nextState);
          PlatformContext.get().getDetection().resetCache();
          const status = nextState ? 'enabled' : 'disabled';
          new Notice(`Mobile emulation ${status}.`, 2500);
        } catch (error) {
          new Notice(`Failed to toggle mobile emulation: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    });

  }

  // Removed complex settings callback system - no longer needed for simplified embeddings
}
