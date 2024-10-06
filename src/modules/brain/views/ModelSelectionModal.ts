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

  constructor(app: App, plugin: BrainModule) {
    super(app);
    this.plugin = plugin;
    this.models = [];
  }

  async onOpen() {
    if (this.plugin.isReinitializing) {
      this.contentEl.setText(
        "AI service is reinitializing. Please try again later.",
      );
      setTimeout(() => this.close(), 2000);
      return;
    }
    super.onOpen();

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("model-selection-modal");
    contentEl.style.maxHeight = "500px";
    contentEl.style.overflow = "auto";
    contentEl.style.marginTop = "20px";
    contentEl.createEl("h2", { text: "Select Model" });

    this.searchInput = contentEl.createEl("input", {
      type: "text",
      placeholder: "Search models...",
      cls: "model-search-input",
    });

    this.modelListContainer = contentEl.createEl("div", { cls: "modal-list" });
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
        cls: "error-message",
      });
    }

    setTimeout(() => this.searchInput.focus(), 0);
  }

  private renderLoadingState(container: HTMLElement) {
    const loadingEl = container.createEl("div", { cls: "loading-models" });
    loadingEl.textContent = "Loading models";
    loadingEl.addClass("revolving-dots");
  }

  private async loadModels() {
    const models = await this.plugin.getEnabledModels();
    this.models = models;

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
      !searchTerms.length ||
      searchTerms.every(
        (term) =>
          model.name.toLowerCase().includes(term) ||
          model.id.toLowerCase().includes(term),
      );

    const renderGroup = (groupName: string, models: Model[]) => {
      if (models.length) {
        this.renderModelGroup(groupName, models, searchTerms);
      }
    };

    renderGroup(
      "Favorited",
      this.models.filter((m) => m.favorite && filterModel(m)),
    );

    ["local", "openai", "groq", "openRouter"].forEach((provider) =>
      renderGroup(
        this.getProviderName(provider),
        this.models.filter((m) => m.provider === provider && filterModel(m)),
      ),
    );

    if (!this.modelListContainer.childElementCount) {
      this.modelListContainer.createEl("div", {
        text: "No models match your search.",
        cls: "no-results-message",
      });
    }

    this.selectedModelIndex = filter
      ? this.modelListContainer.querySelector(".modal-item")
        ? 0
        : -1
      : -1;
    this.updateSelectedModel();
  }

  private renderModelGroup(
    groupName: string,
    models: Model[],
    searchTerms: string[],
  ) {
    this.modelListContainer.createEl("h3", { text: groupName });
    const groupContainer = this.modelListContainer.createEl("div", {
      cls: "modal-group",
    });

    models.forEach((model) => {
      const modelItem = groupContainer.createEl("div", { cls: "modal-item" });
      const nameSpan = modelItem.createEl("span", { cls: "model-name" });
      this.highlightText(nameSpan, model.name, searchTerms);

      if (model.provider !== "local") {
        const contextLengthSpan = modelItem.createEl("span", {
          cls: "model-context-length",
        });
        contextLengthSpan.textContent = model.contextLength
          ? `Context: ${this.formatContextLength(model.contextLength)}`
          : "Context: Unknown";
      }

      const starIcon = modelItem.createEl("span", {
        cls: "model-favorite-star",
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
      element.classList.add("is-favorite");
      element.style.fontVariationSettings = "'FILL' 1";
    } else {
      setIcon(element, "star");
      element.classList.remove("is-favorite");
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
    searchTerms: string[],
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
        span.addClass("fuzzy-match");
      }
    });
  }

  private getProviderName(provider: string): string {
    switch (provider) {
      case "local":
        return "Local";
      case "openai":
        return "OpenAI";
      case "groq":
        return "Groq";
      case "openRouter":
        return "OpenRouter";
      default:
        return provider.charAt(0).toUpperCase() + provider.slice(1);
    }
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
    const modelItems = this.modelListContainer.querySelectorAll(".modal-item");
    if (modelItems.length === 0) return;

    this.selectedModelIndex += direction;
    if (this.selectedModelIndex < 0)
      this.selectedModelIndex = modelItems.length - 1;
    if (this.selectedModelIndex >= modelItems.length)
      this.selectedModelIndex = 0;

    this.updateSelectedModel();
  }

  private updateSelectedModel() {
    const modelItems = this.modelListContainer.querySelectorAll(".modal-item");
    modelItems.forEach((item, index) => {
      if (index === this.selectedModelIndex) {
        item.addClass("selected");
        item.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } else {
        item.removeClass("selected");
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
        `Model: ${model.name}`,
      );
    }
    this.plugin.plugin.settingsTab.display();
    this.close();
  }

  private selectHighlightedModel() {
    const selectedItem = this.modelListContainer.querySelector(
      ".modal-item.selected",
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
}
