import { Modal, App } from 'obsidian';
import { ChatView } from '../ChatView';

export class ActionsModal extends Modal {
  private chatView: ChatView;
  private actions: {
    group: string;
    items: { name: string; callback: () => void }[];
  }[];
  private searchInput: HTMLInputElement;
  private actionListContainer: HTMLElement;
  private selectedActionIndex: number = -1;

  constructor(app: App, chatView: ChatView) {
    super(app);
    this.chatView = chatView;
    this.actions = [
      {
        group: 'General',
        items: [
          {
            name: 'New Chat',
            callback: () => this.chatView.chatModule.openNewChat(),
          },
          {
            name: 'Archive Chat',
            callback: () => this.chatView.archiveChat(),
          },
          {
            name: 'Delete Chat',
            callback: () => this.chatView.deleteChat(),
          },
          {
            name: 'Close Chat',
            callback: () => this.chatView.leaf.detach(),
          },
          {
            name: 'Random Chat',
            callback: () => this.chatView.openRandomChat(),
          },
        ],
      },
      {
        group: 'History',
        items: [
          {
            name: 'Open Chat History',
            callback: () => this.chatView.openChatHistory(),
          },
          {
            name: 'Open Chat History File',
            callback: () => this.chatView.openChatHistoryFile(),
          },
        ],
      },
      {
        group: 'Title',
        items: [
          {
            name: 'Edit Title',
            callback: () => this.chatView.handleEditTitle(),
          },
          {
            name: 'Generate Title',
            callback: () => this.chatView.handleGenerateTitle(),
          },
        ],
      },
      {
        group: 'Tokens',
        items: [
          {
            name: 'Estimate Cost',
            callback: () => this.chatView.openCostEstimator(),
          },
        ],
      },
    ];
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Chat Actions' });

    this.searchInput = contentEl.createEl('input', {
      type: 'text',
      placeholder: 'Search actions...',
      cls: 'action-search-input',
    });

    this.actionListContainer = contentEl.createEl('div', { cls: 'modal-list' });
    this.renderActionList();
    this.setupEventListeners();

    setTimeout(() => this.searchInput.focus(), 0);
  }

  private renderActionList(filter: string = '') {
    this.actionListContainer.empty();
    const searchTerms = filter
      .toLowerCase()
      .split(/\s+/)
      .filter(term => term.length > 0);

    this.actions.forEach(group => {
      const filteredItems = group.items.filter(
        action =>
          searchTerms.length === 0 ||
          searchTerms.every(term => action.name.toLowerCase().includes(term))
      );

      if (filteredItems.length > 0) {
        this.actionListContainer.createEl('h3', { text: group.group });
        const groupContainer = this.actionListContainer.createEl('div', {
          cls: 'modal-group',
        });

        filteredItems.forEach(action => {
          const actionItem = groupContainer.createEl('div', {
            cls: 'modal-item',
          });
          const nameSpan = actionItem.createEl('span');
          this.highlightText(nameSpan, action.name, searchTerms);
          actionItem.addEventListener('click', () => this.selectAction(action));
        });
      }
    });

    if (this.actionListContainer.childElementCount === 0) {
      this.actionListContainer.createEl('div', {
        text: 'No actions match your search.',
        cls: 'no-results-message',
      });
    }

    this.selectedActionIndex = this.actionListContainer.querySelector(
      '.modal-item'
    )
      ? 0
      : -1;
    this.updateSelectedAction();
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
      if (searchTerms.some(term => part.toLowerCase().includes(term))) {
        span.addClass('fuzzy-match');
      }
    });
  }

  private setupEventListeners() {
    this.searchInput.addEventListener('input', () => {
      this.renderActionList(this.searchInput.value);
    });

    this.searchInput.addEventListener(
      'keydown',
      async (event: KeyboardEvent) => {
        switch (event.key) {
          case 'Enter':
            event.preventDefault();
            await this.selectHighlightedAction();
            break;
          case 'Tab':
            event.preventDefault();
            this.navigateActionSelection(event.shiftKey ? -1 : 1);
            break;
          case 'ArrowDown':
            event.preventDefault();
            this.navigateActionSelection(1);
            break;
          case 'ArrowUp':
            event.preventDefault();
            this.navigateActionSelection(-1);
            break;
          case 'Escape':
            if (this.searchInput.value) {
              event.preventDefault();
              this.searchInput.value = '';
              this.renderActionList();
            } else {
              this.close();
            }
            break;
        }
      }
    );
  }

  private navigateActionSelection(direction: number) {
    const actionItems =
      this.actionListContainer.querySelectorAll('.modal-item');
    if (actionItems.length === 0) return;

    this.selectedActionIndex += direction;
    if (this.selectedActionIndex < 0)
      this.selectedActionIndex = actionItems.length - 1;
    if (this.selectedActionIndex >= actionItems.length)
      this.selectedActionIndex = 0;

    this.updateSelectedAction();
  }

  private updateSelectedAction() {
    const actionItems =
      this.actionListContainer.querySelectorAll('.modal-item');
    actionItems.forEach((item, index) => {
      if (index === this.selectedActionIndex) {
        item.addClass('selected');
        item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        item.removeClass('selected');
      }
    });
  }

  private async selectHighlightedAction() {
    const selectedItem = this.actionListContainer.querySelector(
      '.modal-item.selected'
    ) as HTMLElement;
    if (selectedItem) {
      const action = this.actions
        .flatMap(group => group.items)
        .find(
          action =>
            action.name === selectedItem.querySelector('span')?.textContent
        );
      if (action) {
        await this.selectAction(action);
      }
    }
  }

  private async selectAction(action: { callback: () => void }) {
    this.close();
    await action.callback();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
