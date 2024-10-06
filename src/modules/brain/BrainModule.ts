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

export class BrainModule extends EventEmitter implements IGenerationModule {
  plugin: SystemSculptPlugin;
  settings!: BrainSettings;
  private _AIService: AIService | null = null;
  abortController: AbortController | null = null;
  isGenerating: boolean = false;
  isGenerationCompleted: boolean = false;
  favoritedModels: string[] = [];
  private isUpdatingDefaultModel: boolean = false;
  private _isReinitializing: boolean = false;
  private isInitialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;
  public modelSelectionButton: ButtonComponent | null = null;
  private cachedModels: Model[] = [];

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
    if (this.isInitialized) return;
    if (this.initializationPromise) return this.initializationPromise;

    this.initializationPromise = this.initialize();
    await this.initializationPromise;
  }

  private async initialize() {
    try {
      await this.loadSettings();
      await this.initializeAIService();
      this.registerCommands();
      this.initializeStatusBars();
      this.registerViews();
      await this.updateDefaultModelAndStatusBar();
      this.isInitialized = true;
    } catch (error) {
      throw error;
    }
  }

  public async initializeAIService() {
    const {
      openAIApiKey,
      groqAPIKey,
      openRouterAPIKey,
      apiEndpoint,
      localEndpoint,
      temperature,
      showopenAISetting,
      showgroqSetting,
      showlocalEndpointSetting,
      showopenRouterSetting,
      baseOpenAIApiUrl,
    } = this.settings;
    this._AIService = await AIService.getInstance({
      openAIApiKey,
      groqAPIKey,
      openRouterAPIKey,
      apiEndpoint,
      localEndpoint,
      temperature,
      showopenAISetting,
      showgroqSetting,
      showlocalEndpointSetting,
      showopenRouterSetting,
      baseOpenAIApiUrl,
    });
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
      this.plugin.modelToggleStatusBarItem.addClass("model-toggle-button");
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
      (leaf) => new ChatView(leaf, this, this.plugin.chatModule),
    );
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_BRAIN_SETTINGS,
      await this.plugin.loadData(),
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

      this._AIService = await AIService.getInstance(
        {
          openAIApiKey: this.settings.openAIApiKey,
          groqAPIKey: this.settings.groqAPIKey,
          openRouterAPIKey: this.settings.openRouterAPIKey,
          apiEndpoint: this.settings.apiEndpoint,
          localEndpoint: this.settings.localEndpoint,
          temperature: this.settings.temperature,
          showopenAISetting: this.settings.showopenAISetting,
          showgroqSetting: this.settings.showgroqSetting,
          showlocalEndpointSetting: this.settings.showlocalEndpointSetting,
          showopenRouterSetting: this.settings.showopenRouterSetting,
          baseOpenAIApiUrl: this.settings.baseOpenAIApiUrl,
        },
        true,
      );

      await this.updateDefaultModelAndStatusBar();
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
    const allModels = await this._AIService.getModels(
      !!enabledModels.openAIApiKey,
      !!enabledModels.groqAPIKey,
      !!enabledModels.localEndpoint,
      !!enabledModels.openRouterAPIKey,
    );

    return allModels.filter((model) => {
      switch (model.provider) {
        case "openai":
          return enabledModels.openAIApiKey;
        case "groq":
          return enabledModels.groqAPIKey;
        case "local":
          return enabledModels.localEndpoint;
        case "openRouter":
          return enabledModels.openRouterAPIKey;
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
      (model) => model.id === this.settings.defaultModelId,
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

  async getModelById(modelId: string): Promise<Model | undefined> {
    const actualModelId =
      modelId === "default" ? this.settings.defaultModelId : modelId;
    const models = await this.getEnabledModels();
    return models.find((model) => model.id === actualModelId);
  }

  async updateDefaultModelAndStatusBar(): Promise<void> {
    if (this.isUpdatingDefaultModel) return;
    this.isUpdatingDefaultModel = true;

    try {
      this.updateModelStatusBarText("Loading Models...");

      await this._AIService?.ensureModelCacheInitialized();
      this.cachedModels = await this.getEnabledModels();

      if (this.cachedModels.length === 0) {
        this.updateModelStatusBarText("No Models Detected");
      } else {
        const currentModel = this.getCurrentModel();
        this.updateModelStatusBarText(
          this.settings.showDefaultModelOnStatusBar && currentModel
            ? `Model: ${currentModel.name}`
            : "",
        );
      }
    } catch (error) {
      console.error("Error updating default model:", error);
      this.updateModelStatusBarText("Error Detecting Models");
    } finally {
      this.isUpdatingDefaultModel = false;
    }
  }

  private async getEnabledModelSettings() {
    return {
      showopenAISetting: this.settings.showopenAISetting,
      showgroqSetting: this.settings.showgroqSetting,
      showlocalEndpointSetting: this.settings.showlocalEndpointSetting,
      showopenRouterSetting: this.settings.showopenRouterSetting,
    };
  }

  private async getEndpointSettingValues() {
    // first we check which settings are enabled
    const enabledSettings = {
      openAIApiKey: this.settings.showopenAISetting,
      groqAPIKey: this.settings.showgroqSetting,
      openRouterAPIKey: this.settings.showopenRouterSetting,
      localEndpoint: this.settings.showlocalEndpointSetting,
    };

    // now we check which of the enabled settings have a value
    const enabledValues = {
      openAIApiKey: this.settings.openAIApiKey,
      groqAPIKey: this.settings.groqAPIKey,
      openRouterAPIKey: this.settings.openRouterAPIKey,
      localEndpoint: this.settings.localEndpoint,
    };

    // now if they are both true, we return true
    // if they are both false, we return false
    // if they are one true and one false, we return false

    const openAIActive =
      enabledSettings.openAIApiKey && enabledValues.openAIApiKey;
    const groqActive = enabledSettings.groqAPIKey && enabledValues.groqAPIKey;
    const openRouterActive =
      enabledSettings.openRouterAPIKey && enabledValues.openRouterAPIKey;
    const localActive =
      enabledSettings.localEndpoint && enabledValues.localEndpoint;

    return {
      // return as booleans
      openAIApiKey: openAIActive,
      groqAPIKey: groqActive,
      openRouterAPIKey: openRouterActive,
      localEndpoint: localActive,
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
        this.getMaxOutputTokens(),
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
        (model) => model.id === this.settings.defaultModelId,
      ) || this.cachedModels[0]
    );
  }

  private focusActiveMarkdownView() {
    const activeLeaf = this.plugin.app.workspace.activeLeaf;
    if (activeLeaf && activeLeaf.view instanceof MarkdownView) {
      activeLeaf.view.editor.focus();
    }
  }
}
