import { Modal, App } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { Model } from '../../../api/Model';

export class ModelSelectionModal extends Modal {
  private plugin: BrainModule;
  private models: Model[] | null;
  private searchInput: HTMLInputElement;
  private modelListContainer: HTMLElement;
  private selectedModelIndex: number = -1;

  constructor(app: App, plugin: BrainModule) {
    super(app);
    this.plugin = plugin;
    this.models = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Select Model' });

    // Create search input
    this.searchInput = contentEl.createEl('input', {
      type: 'text',
      placeholder: 'Search models...',
      cls: 'model-search-input',
    });

    this.modelListContainer = contentEl.createEl('div', { cls: 'modal-list' });
    this.renderLoadingState(this.modelListContainer);

    this.loadModels().then(() => {
      this.renderModelList();
      this.setupEventListeners();
    });

    // Set focus to the search input
    setTimeout(() => this.searchInput.focus(), 0);
  }

  private renderLoadingState(container: HTMLElement) {
    const loadingEl = container.createEl('div', { cls: 'loading-models' });
    loadingEl.textContent = 'Loading models';
    loadingEl.addClass('revolving-dots');
  }

  private async loadModels() {
    const models = await this.plugin.openAIService.getModels();
    this.models = models.filter(
      model =>
        (model.provider === 'openai' &&
          this.plugin.settings.showopenAISetting) ||
        (model.provider === 'groq' && this.plugin.settings.showgroqSetting) ||
        (model.provider === 'local' &&
          this.plugin.settings.showlocalEndpointSetting) ||
        (model.provider === 'openRouter' &&
          this.plugin.settings.showOpenRouterSetting)
    );
  }

  private renderModelList(filter: string = '') {
    this.modelListContainer.empty();
    if (!this.models || this.models.length === 0) {
      this.modelListContainer.createEl('div', {
        text: 'No enabled models available.',
      });
      return;
    }

    const providers = ['local', 'openai', 'groq', 'openRouter'];
    const searchTerms = filter
      .toLowerCase()
      .split(/\s+/)
      .filter(term => term.length > 0);

    providers.forEach(provider => {
      // @ts-ignore
      const providerModels = this.models.filter(
        model =>
          model.provider === provider &&
          (searchTerms.length === 0 ||
            searchTerms.every(
              term =>
                model.name.toLowerCase().includes(term) ||
                model.id.toLowerCase().includes(term)
            ))
      );
      if (providerModels.length > 0) {
        this.modelListContainer.createEl('h3', {
          text: this.getProviderName(provider),
        });
        const groupContainer = this.modelListContainer.createEl('div', {
          cls: 'modal-group',
        });

        providerModels.forEach(model => {
          const modelItem = groupContainer.createEl('div', {
            cls: 'modal-item',
          });
          const nameSpan = modelItem.createEl('span');
          this.highlightText(nameSpan, model.name, searchTerms);
          modelItem.addEventListener('click', () => this.selectModel(model));
          modelItem.dataset.modelId = model.id;
        });
      }
    });

    if (this.modelListContainer.childElementCount === 0) {
      this.modelListContainer.createEl('div', {
        text: 'No models match your search.',
        cls: 'no-results-message',
      });
    }

    // Set the selectedModelIndex to 0 (first item) if there are any results
    this.selectedModelIndex = this.modelListContainer.querySelector(
      '.modal-item'
    )
      ? 0
      : -1;
    this.updateSelectedModel();
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

    const regex = new RegExp(`(${searchTerms.join('|')})`, 'gi');
    const parts = text.split(regex);

    parts.forEach(part => {
      const span = element.createEl('span');
      span.textContent = part;
      if (searchTerms.some(term => part.toLowerCase() === term)) {
        span.addClass('fuzzy-match');
      }
    });
  }

  private getProviderName(provider: string): string {
    switch (provider) {
      case 'local':
        return 'Local';
      case 'openai':
        return 'OpenAI';
      case 'groq':
        return 'Groq';
      case 'openRouter':
        return 'OpenRouter';
      default:
        return provider.charAt(0).toUpperCase() + provider.slice(1);
    }
  }

  private setupEventListeners() {
    this.searchInput.addEventListener('input', () => {
      this.renderModelList(this.searchInput.value);
    });

    this.searchInput.addEventListener('keydown', (event: KeyboardEvent) => {
      switch (event.key) {
        case 'Enter':
          this.selectHighlightedModel();
          break;
        case 'Tab':
          event.preventDefault();
          this.navigateModelSelection(event.shiftKey ? -1 : 1);
          break;
        case 'ArrowDown':
          event.preventDefault();
          this.navigateModelSelection(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          this.navigateModelSelection(-1);
          break;
        case 'Escape':
          if (this.searchInput.value) {
            event.preventDefault();
            this.searchInput.value = '';
            this.renderModelList();
          } else {
            this.close();
          }
          break;
      }
    });
  }

  private navigateModelSelection(direction: number) {
    const modelItems = this.modelListContainer.querySelectorAll('.modal-item');
    if (modelItems.length === 0) return;

    this.selectedModelIndex += direction;
    if (this.selectedModelIndex < 0)
      this.selectedModelIndex = modelItems.length - 1;
    if (this.selectedModelIndex >= modelItems.length)
      this.selectedModelIndex = 0;

    this.updateSelectedModel();
  }

  private updateSelectedModel() {
    const modelItems = this.modelListContainer.querySelectorAll('.modal-item');
    modelItems.forEach((item, index) => {
      if (index === this.selectedModelIndex) {
        item.addClass('selected');
        item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        item.removeClass('selected');
      }
    });
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
    this.plugin.plugin.settingsTab.display(); // Added this line
    this.close();
  }

  private selectHighlightedModel() {
    const selectedItem = this.modelListContainer.querySelector(
      '.modal-item.selected'
    ) as HTMLElement;
    if (selectedItem) {
      const modelId = selectedItem.dataset.modelId;
      // @ts-ignore
      const model = this.models.find(m => m.id === modelId);
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
