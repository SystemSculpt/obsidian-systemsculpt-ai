import { Modal, App } from "obsidian";
import { BrainModule } from "../BrainModule";
import { Model } from "../../../api/Model";
import { setIcon } from "obsidian";

export class ModelSelectionModal extends Modal {
  private plugin: BrainModule;
  private models: Model[] = [];
  private searchInput!: HTMLInputElement;
  private modelListContainer!: HTMLElement;
  private selectedModelIndex: number = -1;
  private providerCheckboxes: Record<string, HTMLInputElement> = {};

  constructor(app: App, plugin: BrainModule) {
    super(app);
    this.plugin = plugin;
    this.models = [];
  }

  async onOpen() {
    if (this.plugin.isReinitializing) {
      this.contentEl.setText(
        "AI service is reinitializing. Please try again later."
      );
      setTimeout(() => this.close(), 2000);
      return;
    }
    super.onOpen();

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("systemsculpt-model-selection-modal");
    contentEl.style.maxHeight = "500px";
    contentEl.style.overflow = "auto";
    contentEl.style.marginTop = "20px";
    contentEl.createEl("h2", { text: "Select Model" });

    this.addRefreshButton();
    this.addProviderCheckboxes();

    this.searchInput = contentEl.createEl("input", {
      type: "text",
      placeholder: "Search models...",
      cls: "systemsculpt-model-search-input",
    });

    this.modelListContainer = contentEl.createEl("div", {
      cls: "systemsculpt-modal-list",
    });
    this.renderLoadingState(this.modelListContainer);

    try {
      await this.loadModels();
      this.renderModelList();
      this.setupEventListeners();
    } catch (error) {
      console.error("Error loading models:", error);
      this.modelListContainer.empty();
      this.modelListContainer.createEl("div", {
        text: "Error loading models. Please try again later.",
        cls: "systemsculpt-error-message",
      });
    }

    setTimeout(() => this.searchInput.focus(), 0);
  }

  private renderLoadingState(container: HTMLElement) {
    const loadingEl = container.createEl("div", {
      cls: "systemsculpt-loading-models",
    });
    loadingEl.textContent = this.plugin.currentLoadingProvider
      ? `Loading ${this.plugin.currentLoadingProvider} models...`
      : "Loading models...";
    loadingEl.addClass("systemsculpt-revolving-dots");
  }

  private async loadModels() {
    await this.plugin.getEndpointSettingValues();
    this.models = await this.plugin.AIService.getModels();

    const favoritedModels = new Set(this.plugin.settings.favoritedModels || []);
    this.models.forEach((model) => {
      model.favorite = favoritedModels.has(model.id);
    });
  }

  private renderModelList(filter: string = "") {
    this.modelListContainer.empty();
    if (!this.models || this.models.length === 0) {
      this.modelListContainer.createEl("div", {
        text: "No enabled models available.",
      });
      return;
    }

    const searchTerms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const filterModel = (model: Model) =>
      this.shouldDisplayModel(model) &&
      (!searchTerms.length ||
        searchTerms.every(
          (term) =>
            model.name.toLowerCase().includes(term) ||
            model.id.toLowerCase().includes(term)
        ));

    const renderGroup = (groupName: string, models: Model[]) => {
      if (models.length) {
        this.renderModelGroup(groupName, models, searchTerms);
      }
    };

    // Only render Favorited group if the checkbox is checked
    if (this.providerCheckboxes["Favorited"].checked) {
      renderGroup(
        "Favorited",
        this.models.filter((m) => m.favorite && filterModel(m))
      );
    }

    ["Local", "OpenAI", "Groq", "OpenRouter", "Anthropic"].forEach((provider) =>
      renderGroup(
        provider,
        this.models.filter(
          (m) =>
            m.provider.toLowerCase() === provider.toLowerCase() &&
            filterModel(m)
        )
      )
    );

    if (!this.modelListContainer.childElementCount) {
      this.modelListContainer.createEl("div", {
        text: "No models match your search.",
        cls: "systemsculpt-no-results-message",
      });
    }

    this.selectedModelIndex = filter
      ? this.modelListContainer.querySelector(".systemsculpt-modal-item")
        ? 0
        : -1
      : -1;
    this.updateSelectedModel();
  }

  private renderModelGroup(
    groupName: string,
    models: Model[],
    searchTerms: string[]
  ) {
    this.modelListContainer.createEl("h3", { text: groupName });
    const groupContainer = this.modelListContainer.createEl("div", {
      cls: "systemsculpt-modal-group",
    });

    models.forEach((model) => {
      const modelItem = groupContainer.createEl("div", {
        cls: "systemsculpt-modal-item",
      });
      const nameSpan = modelItem.createEl("span", {
        cls: "systemsculpt-model-name",
      });
      this.highlightText(nameSpan, model.name, searchTerms);

      if (model.provider !== "local") {
        const contextLengthSpan = modelItem.createEl("span", {
          cls: "systemsculpt-model-context-length",
        });
        contextLengthSpan.textContent = model.contextLength
          ? `Context: ${this.formatContextLength(model.contextLength)}`
          : "Context: Unknown";
      }

      const starIcon = modelItem.createEl("span", {
        cls: "systemsculpt-model-favorite-star",
      });
      this.updateFavoriteIcon(starIcon, model.favorite ?? false);

      starIcon.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggleFavorite(model);
      });

      // Add hover effect for both favorited and unfavorited states
      starIcon.addEventListener("mouseenter", () => {
        if (model.favorite) {
          setIcon(starIcon, "star-off");
        } else {
          setIcon(starIcon, "star");
          starIcon.style.fontVariationSettings = "'FILL' 1";
        }
      });

      starIcon.addEventListener("mouseleave", () => {
        this.updateFavoriteIcon(starIcon, model.favorite ?? false);
      });

      modelItem.addEventListener("click", () => this.selectModel(model));
      modelItem.dataset.modelId = model.id;
    });
  }

  private updateFavoriteIcon(element: HTMLElement, isFavorite: boolean) {
    if (isFavorite) {
      setIcon(element, "star");
      element.classList.add("systemsculpt-is-favorite");
      element.style.fontVariationSettings = "'FILL' 1";
    } else {
      setIcon(element, "star");
      element.classList.remove("systemsculpt-is-favorite");
      element.style.fontVariationSettings = "'FILL' 0";
    }
  }

  private toggleFavorite(model: Model) {
    model.favorite = !model.favorite;
    this.plugin.settings.favoritedModels = this.models
      .filter((m) => m.favorite)
      .map((m) => m.id);
    this.plugin.saveSettings();
    this.renderModelList(this.searchInput.value);
  }

  private highlightText(
    element: HTMLElement,
    text: string,
    searchTerms: string[]
  ) {
    if (searchTerms.length === 0) {
      element.textContent = text;
      return;
    }

    const regex = new RegExp(`(${searchTerms.join("|")})`, "gi");
    const parts = text.split(regex);

    parts.forEach((part) => {
      const span = element.createEl("span");
      span.textContent = part;
      if (searchTerms.some((term) => part.toLowerCase() === term)) {
        span.addClass("systemsculpt-fuzzy-match");
      }
    });
  }

  private formatContextLength(contextLength: number): string {
    if (contextLength >= 1000) {
      return `${(contextLength / 1000).toFixed(0)}K`;
    }
    return contextLength.toString();
  }

  private setupEventListeners() {
    this.searchInput.addEventListener("input", () => {
      this.renderModelList(this.searchInput.value);
    });

    this.searchInput.addEventListener("keydown", (event: KeyboardEvent) => {
      switch (event.key) {
        case "Enter":
          this.selectHighlightedModel();
          break;
        case "Tab":
          event.preventDefault();
          this.navigateModelSelection(event.shiftKey ? -1 : 1);
          break;
        case "ArrowDown":
          event.preventDefault();
          this.navigateModelSelection(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          this.navigateModelSelection(-1);
          break;
        case "Escape":
          if (this.searchInput.value) {
            event.preventDefault();
            this.searchInput.value = "";
            this.renderModelList();
          } else {
            this.close();
          }
          break;
      }
    });
  }

  private navigateModelSelection(direction: number) {
    const modelItems = this.modelListContainer.querySelectorAll(
      ".systemsculpt-modal-item"
    );
    if (modelItems.length === 0) return;

    this.selectedModelIndex += direction;
    if (this.selectedModelIndex < 0)
      this.selectedModelIndex = modelItems.length - 1;
    if (this.selectedModelIndex >= modelItems.length)
      this.selectedModelIndex = 0;

    this.updateSelectedModel();
  }

  private updateSelectedModel() {
    const modelItems = this.modelListContainer.querySelectorAll(
      ".systemsculpt-modal-item"
    );
    modelItems.forEach((item, index) => {
      if (index === this.selectedModelIndex) {
        item.addClass("systemsculpt-selected");
        item.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } else {
        item.removeClass("systemsculpt-selected");
      }
    });

    // Add this condition
    if (this.selectedModelIndex === -1) {
      this.modelListContainer.scrollTop = 0;
    }
  }

  private async selectModel(model: Model) {
    this.plugin.settings.defaultModelId = model.id;
    await this.plugin.saveSettings();
    this.plugin.refreshAIService();
    if (this.plugin.plugin.modelToggleStatusBarItem) {
      this.plugin.plugin.modelToggleStatusBarItem.setText(
        `Model: ${model.name}`
      );
    }
    this.plugin.plugin.settingsTab.display();
    this.close();
  }

  private selectHighlightedModel() {
    const selectedItem = this.modelListContainer.querySelector(
      ".systemsculpt-modal-item.systemsculpt-selected"
    ) as HTMLElement;
    if (selectedItem) {
      const modelId = selectedItem.dataset.modelId;
      // @ts-ignore
      const model = this.models.find((m) => m.id === modelId);
      if (model) {
        this.selectModel(model);
      }
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }

  private addRefreshButton() {
    const refreshButton = this.contentEl.createEl("button", {
      text: "Refresh Models List",
      cls: "systemsculpt-refresh-models-button",
    });
    refreshButton.addEventListener("click", async () => {
      refreshButton.textContent = "Refreshing models...";
      refreshButton.disabled = true;
      await this.refreshModels();
      refreshButton.textContent = "Refresh Models List";
      refreshButton.disabled = false;
      this.renderModelList();
    });
  }

  private addProviderCheckboxes() {
    const providers = [
      "Favorited",
      "Local",
      "OpenAI",
      "Groq",
      "OpenRouter",
      "Anthropic",
    ];
    const checkboxContainer = this.contentEl.createEl("div", {
      cls: "systemsculpt-provider-checkboxes",
    });

    providers.forEach((provider) => {
      const label = checkboxContainer.createEl("label", {
        cls: "systemsculpt-provider-checkbox-label",
      });
      const checkbox = label.createEl("input", {
        type: "checkbox",
        cls: "systemsculpt-provider-checkbox",
      });
      const settingKey =
        `show${provider}Models` as keyof typeof this.plugin.settings;
      checkbox.checked = this.plugin.settings[settingKey] as boolean;
      label.appendText(provider);

      checkbox.addEventListener("change", async () => {
        this.plugin.settings[settingKey] = checkbox.checked as never;
        await this.plugin.saveSettings();
        this.renderModelList(this.searchInput.value);
      });

      this.providerCheckboxes[provider] = checkbox;
    });
  }

  private showRefreshingState() {
    this.modelListContainer.empty();
    const refreshingEl = this.modelListContainer.createEl("div", {
      cls: "systemsculpt-refreshing-models",
    });
    refreshingEl.textContent = "Refreshing models list";
    refreshingEl.addClass("systemsculpt-revolving-dots");
  }

  private hideRefreshingState() {
    const refreshingEl = this.modelListContainer.querySelector(
      ".systemsculpt-refreshing-models"
    );
    if (refreshingEl) {
      refreshingEl.remove();
    }
  }

  private async refreshModels() {
    this.showRefreshingState();
    try {
      await this.plugin.reinitializeAIService();
      await this.loadModels();
    } catch (error) {
      console.error("Error refreshing models:", error);
      this.modelListContainer.empty();
      this.modelListContainer.createEl("div", {
        text: "Error refreshing models. Please try again later.",
        cls: "systemsculpt-error-message",
      });
    } finally {
      this.hideRefreshingState();
    }
  }

  private shouldDisplayModel(model: Model): boolean {
    const providerKey = this.getProviderCheckboxKey(model.provider);
    const settingKey =
      `show${providerKey}Models` as keyof typeof this.plugin.settings;
    return this.plugin.settings[settingKey] as boolean;
  }

  private getProviderCheckboxKey(provider: string): string {
    switch (provider.toLowerCase()) {
      case "local":
        return "Local";
      case "openai":
        return "OpenAI";
      case "groq":
        return "Groq";
      case "openrouter":
        return "OpenRouter";
      case "anthropic":
        return "Anthropic";
      default:
        return provider;
    }
  }
}
