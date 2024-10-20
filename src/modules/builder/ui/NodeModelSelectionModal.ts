import { Modal, App } from "obsidian";
import { Model } from "../../../api/Model";
import SystemSculptPlugin from "../../../main";

export class NodeModelSelectionModal extends Modal {
  private callback: (selectedModel: Model) => void;
  private models: Model[] = [];
  private searchInput!: HTMLInputElement;
  private modelListContainer!: HTMLElement;
  private selectedModelIndex: number = -1;
  private plugin: SystemSculptPlugin;

  constructor(
    app: App,
    plugin: SystemSculptPlugin,
    callback: (selectedModel: Model) => void
  ) {
    super(app);
    this.callback = callback;
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("systemsculpt-node-model-selection-modal");
    contentEl.style.maxHeight = "500px";
    contentEl.style.overflow = "auto";
    contentEl.style.marginTop = "20px";
    contentEl.createEl("h2", { text: "Select Model for Node" });

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
    loadingEl.textContent = "Loading models";
    loadingEl.addClass("systemsculpt-revolving-dots");
  }

  private async loadModels() {
    const brainModule = this.plugin.brainModule;
    const enabledModels = await brainModule.getEndpointSettingValues();
    this.models = await brainModule.AIService.getModels(
      enabledModels.openAIApiKey,
      enabledModels.groqAPIKey,
      enabledModels.localEndpoint,
      enabledModels.openRouterAPIKey
    );
  }

  private renderModelList(filter: string = "") {
    this.modelListContainer.empty();
    if (!this.models || this.models.length === 0) {
      this.modelListContainer.createEl("div", {
        text: "No models available.",
      });
      return;
    }

    const searchTerms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const filterModel = (model: Model) =>
      !searchTerms.length ||
      searchTerms.every(
        (term) =>
          model.name.toLowerCase().includes(term) ||
          model.id.toLowerCase().includes(term)
      );

    const renderGroup = (groupName: string, models: Model[]) => {
      if (models.length) {
        this.renderModelGroup(groupName, models, searchTerms);
      }
    };

    ["Local", "OpenAI", "Groq", "OpenRouter"].forEach((provider) =>
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

      modelItem.addEventListener("click", () => this.selectModel(model));
      modelItem.dataset.modelId = model.id;
    });
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

    if (this.selectedModelIndex === -1) {
      this.modelListContainer.scrollTop = 0;
    }
  }

  private selectModel(model: Model) {
    this.callback(model);
    this.close();
  }

  private selectHighlightedModel() {
    const selectedItem = this.modelListContainer.querySelector(
      ".systemsculpt-modal-item.systemsculpt-selected"
    ) as HTMLElement;
    if (selectedItem) {
      const modelId = selectedItem.dataset.modelId;
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
