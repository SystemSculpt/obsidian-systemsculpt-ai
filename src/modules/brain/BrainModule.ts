import SystemSculptPlugin from "../../main";
import {
  BrainSettings,
  DEFAULT_BRAIN_SETTINGS,
} from "./settings/BrainSettings";
import { AIService } from "../../api/AIService";
import { Model } from "../../api/Model";
import { BrainSettingTab } from "./settings/BrainSettingTab";
import { generateTitle } from "./functions/generateTitle";
import { generateTitleForCurrentNote } from "./functions/generateTitleForCurrentNote";
import { toggleGeneration } from "./functions/toggleGeneration";
import { MarkdownView } from "obsidian";
import { IGenerationModule } from "../../interfaces/IGenerationModule";
import { showCustomNotice } from "../../modals";
import { stopGeneration } from "./functions/stopGeneration";
import { ChatView, VIEW_TYPE_CHAT } from "../chat/ChatView";
import { ModelSelectionModal } from "./views/ModelSelectionModal";
import { EventEmitter } from "events";
import { ButtonComponent } from "obsidian";
import { CostEstimator } from "../../interfaces/CostEstimatorModal";
import { logModuleLoadTime } from "../../utils/timing";

export class BrainModule extends EventEmitter implements IGenerationModule {
  plugin: SystemSculptPlugin;
  settings!: BrainSettings;
  private _AIService: AIService | null = null;
  abortController: AbortController | null = null;
  isGenerating: boolean = false;
  isGenerationCompleted: boolean = false;
  favoritedModels: string[] = [];
  showFavoritedModels: boolean = true;
  showLocalModels: boolean = true;
  showOpenAIModels: boolean = true;
  showGroqModels: boolean = true;
  showOpenRouterModels: boolean = true;
  private isUpdatingDefaultModel: boolean = false;
  private _isReinitializing: boolean = false;
  private isInitialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;
  public modelSelectionButton: ButtonComponent | null = null;
  private cachedModels: Model[] = [];
  private modelInitializationPromise: Promise<void> | null = null;
  private modelLoadTimeout: NodeJS.Timeout | null = null;
  public currentLoadingProvider: string | null = null;

  constructor(plugin: SystemSculptPlugin) {
    super();
    this.plugin = plugin;
  }

  get isReinitializing(): boolean {
    return this._isReinitializing;
  }

  set isReinitializing(value: boolean) {
    if (this._isReinitializing !== value) {
      this._isReinitializing = value;
      this.emit("reinitialization-status-changed");
    }
  }

  get AIService(): AIService {
    if (!this._AIService) {
      throw new Error("AIService is not initialized");
    }
    return this._AIService;
  }

  getAIService(): AIService {
    return this.AIService;
  }

  getMaxOutputTokens(): number {
    const currentModel = this.getCurrentModel();
    return currentModel?.maxOutputTokens || 4096;
  }

  public async load() {
    const startTime = performance.now();
    if (this.isInitialized) return;
    if (this.initializationPromise) return this.initializationPromise;

    this.initializationPromise = this.initialize();
    await this.initializationPromise;
    logModuleLoadTime("Brain", startTime);

    // Start model loading in background
    this.loadModelsWithTimeout();
  }

  private async initialize() {
    try {
      await this.loadSettings();
      this._AIService = this.plugin.aiService;

      this.registerCommands();
      this.initializeStatusBars();
      this.registerViews();

      this.updateModelStatusBarText("Loading models...");

      if (!this.modelInitializationPromise) {
        this.modelInitializationPromise = this.initializeModels();
      }

      this.isInitialized = true;
    } catch (error) {
      console.error("Error initializing BrainModule:", error);
      throw error;
    }
  }

  private async initializeModels() {
    try {
      this.updateModelLoadingStatus("all");
      if (this._AIService) {
        await this._AIService.initializeModelCache();
        const models = await this._AIService.getModels();
        this.cachedModels = models;

        // Get the current model name immediately after loading
        const modelName = await this.getCurrentModelShortName();
        this.updateModelStatusBarText(modelName);
        this.updateModelSelectionButton(modelName, false);
      }
    } catch (error) {
      console.warn("Failed to initialize models:", error);
      this.updateModelStatusBarText("No Models Available");
    } finally {
      this.updateModelLoadingStatus(null);
    }
  }

  private registerCommands() {
    this.plugin.addCommand({
      id: "generate-note-title",
      name: "Generate title for current note",
      callback: async () => await this.generateTitleForCurrentNote(),
    });

    this.plugin.addCommand({
      id: "toggle-general-generation",
      name: "Toggle general generation",
      callback: async () => await this.toggleGeneration(),
    });

    this.plugin.addCommand({
      id: "cycle-through-models",
      name: "Cycle through available models",
      callback: async () => {
        await this.cycleModels();
        this.focusActiveMarkdownView();
      },
    });

    this.plugin.addCommand({
      id: "stop-all-generation-processes",
      name: "Stop all generation processes",
      callback: async () => await stopGeneration(this),
    });
  }

  private initializeStatusBars() {
    this.initializeModelStatusBar();
  }

  private initializeModelStatusBar() {
    if (!this.plugin.modelToggleStatusBarItem) {
      this.plugin.modelToggleStatusBarItem = this.plugin.addStatusBarItem();
      this.plugin.modelToggleStatusBarItem.addClass(
        "systemsculpt-status-bar-button"
      );
      this.plugin.modelToggleStatusBarItem.addClass(
        "systemsculpt-model-toggle-button"
      );
    }
    this.plugin.modelToggleStatusBarItem.onClickEvent(async () => {
      if (!this.isReinitializing) {
        await this.cycleModels();
      }
    });
  }

  private registerViews() {
    this.plugin.registerView(
      VIEW_TYPE_CHAT,
      (leaf) => new ChatView(leaf, this, this.plugin.chatModule)
    );
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_BRAIN_SETTINGS,
      await this.plugin.loadData()
    );
  }

  async saveSettings() {
    await this.plugin.saveSettings(this.settings);
  }

  async refreshAIService() {
    try {
      if (
        this.settings.localEndpoint &&
        !this.isValidLocalEndpoint(this.settings.localEndpoint)
      ) {
        this.settings.localEndpoint = "";
        await this.saveSettings();
      }

      this.updateModelStatusBarText("Reloading Models...");
      this.updateModelSelectionButton("Reloading Models...", true);

      const {
        openAIApiKey,
        groqAPIKey,
        openRouterAPIKey,
        localEndpoint,
        anthropicApiKey,
        temperature,
        showopenAISetting,
        showgroqSetting,
        showlocalEndpointSetting,
        showopenRouterSetting,
        showAnthropicSetting,
      } = this.settings;

      this._AIService = await AIService.getInstance({
        openAIApiKey,
        groqAPIKey,
        openRouterAPIKey,
        localEndpoint,
        anthropicApiKey,
        temperature,
        showopenAISetting,
        showgroqSetting,
        showlocalEndpointSetting,
        showopenRouterSetting,
        showAnthropicSetting,
      });

      // Trigger model cache refresh in background
      this._AIService.initializeModelCache().catch(console.error);
    } catch (error) {
      this.updateModelStatusBarText("Error: Check settings");
      this.updateModelSelectionButton("Error: Check settings", false);
    }
  }

  private updateModelSelectionButton(text: string, disabled: boolean) {
    if (this.modelSelectionButton) {
      this.modelSelectionButton.setButtonText(text);
      this.modelSelectionButton.setDisabled(disabled);
    }
  }

  public isValidLocalEndpoint(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch (error) {
      return false;
    }
  }

  settingsDisplay(containerEl: HTMLElement): void {
    new BrainSettingTab(this.plugin.app, this, containerEl).display();
  }

  async generateTitle(noteContent: string): Promise<string> {
    return generateTitle(this, noteContent);
  }

  async generateTitleForCurrentNote(): Promise<void> {
    return generateTitleForCurrentNote(this);
  }

  async toggleGeneration(): Promise<void> {
    return toggleGeneration(this);
  }

  async cycleModels(): Promise<void> {
    new ModelSelectionModal(this.plugin.app, this).open();
  }

  public async getEnabledModels(): Promise<Model[]> {
    if (!this._AIService) {
      throw new Error("AIService is not initialized");
    }
    const enabledModels = await this.getEndpointSettingValues();
    const allModels = await this._AIService.getModels();

    return allModels.filter((model: Model) => {
      switch (model.provider) {
        case "openai":
          return enabledModels.openAIApiKey;
        case "groq":
          return enabledModels.groqAPIKey;
        case "local":
          return enabledModels.localEndpoint;
        case "openRouter":
          return enabledModels.openRouterAPIKey;
        case "anthropic":
          return enabledModels.anthropicApiKey;
        default:
          return false;
      }
    });
  }

  async getCurrentModelShortName(): Promise<string> {
    const enabledModels = await this.getEndpointSettingValues();
    if (Object.values(enabledModels).every((setting) => !setting)) {
      return "No Models Detected";
    }

    const models = await this.getEnabledModels();

    let currentModel = models.find(
      (model) => model.id === this.settings.defaultModelId
    );
    if (!currentModel && models.length > 0) {
      currentModel = models[0];
      this.settings.defaultModelId = currentModel.id;
      await this.saveSettings();
    }

    return currentModel ? currentModel.name : "No Models Detected";
  }

  stopGeneration(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.isGenerationCompleted = false;
      showCustomNotice("Generation stopped by user", 5000);
    }
  }

  public async getModelById(modelId: string): Promise<Model | undefined> {
    // Wait for initial model load if needed
    if (this.cachedModels.length === 0) {
      await this.AIService.initializeModelCache();
    }

    return this.cachedModels.find((model) => model.id === modelId);
  }

  async updateDefaultModelAndStatusBar() {
    try {
      const models = (await this._AIService?.getModels()) || [];
      if (models.length === 0) {
        this.updateModelStatusBarText("No Models Available");
        return;
      }

      const currentModel = this.getCurrentModel();
      if (!currentModel || !models.some((m) => m.id === currentModel.id)) {
        // Set first available model as default if current is invalid
        this.settings.defaultModelId = models[0].id;
        await this.saveSettings();
      }

      const modelName = this.getCurrentModel()?.name || "Select Model";
      this.updateModelStatusBarText(modelName);
      this.updateModelSelectionButton(modelName, false);
    } catch (error) {
      console.warn("Error updating default model:", error);
      this.updateModelStatusBarText("Error Loading Models");
    }
  }

  public async getEndpointSettingValues() {
    const enabledSettings = {
      openAIApiKey: this.settings.showopenAISetting,
      groqAPIKey: this.settings.showgroqSetting,
      openRouterAPIKey: this.settings.showopenRouterSetting,
      localEndpoint: this.settings.showlocalEndpointSetting,
      anthropicApiKey: this.settings.showAnthropicSetting,
    };

    const enabledValues = {
      openAIApiKey: this.settings.openAIApiKey,
      groqAPIKey: this.settings.groqAPIKey,
      openRouterAPIKey: this.settings.openRouterAPIKey,
      localEndpoint: this.settings.localEndpoint,
      anthropicApiKey: this.settings.anthropicApiKey,
    };

    return {
      openAIApiKey:
        enabledSettings.openAIApiKey && !!enabledValues.openAIApiKey,
      groqAPIKey: enabledSettings.groqAPIKey && !!enabledValues.groqAPIKey,
      openRouterAPIKey:
        enabledSettings.openRouterAPIKey && !!enabledValues.openRouterAPIKey,
      localEndpoint:
        enabledSettings.localEndpoint && !!enabledValues.localEndpoint,
      anthropicApiKey:
        enabledSettings.anthropicApiKey && !!enabledValues.anthropicApiKey,
    };
  }

  private updateModelStatusBarText(text: string) {
    if (this.plugin.modelToggleStatusBarItem) {
      this.plugin.modelToggleStatusBarItem?.setText(text);
    }
    this.emit("model-changed", this.settings.defaultModelId);
  }

  public updateCostEstimate(tokenCount: number) {
    const currentModel = this.getCurrentModel();
    if (currentModel && currentModel.pricing) {
      const { minCost, maxCost } = CostEstimator.calculateCost(
        currentModel,
        tokenCount,
        this.getMaxOutputTokens()
      );
      this.emit("cost-estimate-updated", { minCost, maxCost });
    }
  }

  public getCurrentModel(): Model | null {
    if (this.cachedModels.length === 0) {
      return null;
    }
    return (
      this.cachedModels.find(
        (model) => model.id === this.settings.defaultModelId
      ) || this.cachedModels[0]
    );
  }

  private focusActiveMarkdownView() {
    const activeLeaf = this.plugin.app.workspace.activeLeaf;
    if (activeLeaf && activeLeaf.view instanceof MarkdownView) {
      activeLeaf.view.editor.focus();
    }
  }

  private loadModelsWithTimeout() {
    if (this.modelLoadTimeout) {
      clearTimeout(this.modelLoadTimeout);
    }

    this.modelLoadTimeout = setTimeout(async () => {
      try {
        if (this._AIService) {
          await this._AIService.initializeModelCache(undefined, true);
          const models = await this._AIService.getModels();
          this.cachedModels = models;
          const modelName = await this.getCurrentModelShortName();
          this.updateModelStatusBarText(modelName);
          this.updateModelSelectionButton(modelName, false);
        }
      } catch (error) {
        console.warn("Failed to load models:", error);
        this.updateModelStatusBarText("Error Loading Models");
      }
    }, 1000);
  }

  async refreshModels() {
    if (this._AIService) {
      this._AIService.clearModelCache();
      this.loadModelsWithTimeout();
    }
  }

  private updateModelLoadingStatus(provider: string | null) {
    this.currentLoadingProvider = provider;
    const text = provider
      ? `Loading ${provider} models...`
      : "Loading models...";
    this.updateModelStatusBarText(text);
    this.updateModelSelectionButton(text, true);
  }
}
