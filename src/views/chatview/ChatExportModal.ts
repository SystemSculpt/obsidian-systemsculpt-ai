import { Modal, Notice, Setting, TFile } from 'obsidian';
import { attachFolderSuggester } from '../../components/FolderSuggester';
import type SystemSculptPlugin from '../../main';
import { createDefaultChatExportOptions, normalizeChatExportOptions, ChatExportOptions, ChatExportPreferences } from '../../types/chatExport';
import type { ChatView } from './ChatView';
import { sanitizeChatTitle } from '../../utils/titleUtils';
import { errorLogger } from '../../utils/errorLogger';

interface ChatExportModalState {
  options: ChatExportOptions;
  folder: string;
  fileName: string;
  openAfterExport: boolean;
}

export class ChatExportModal extends Modal {
  private readonly plugin: SystemSculptPlugin;
  private readonly chatView: ChatView;
  private state: ChatExportModalState;
  private folderInput: HTMLInputElement | null = null;
  private fileNameInput: HTMLInputElement | null = null;
  private openAfterExportCheckbox: HTMLInputElement | null = null;

  constructor(plugin: SystemSculptPlugin, chatView: ChatView) {
    super(plugin.app);
    this.plugin = plugin;
    this.chatView = chatView;

    const preferences = this.resolvePreferences();
    const defaultFolder = preferences.lastFolder || this.plugin.settings.chatsDirectory;
    const defaultFileName = preferences.lastFileName || this.generateDefaultFileName();
    const options = normalizeChatExportOptions(preferences.options);

    this.state = {
      options,
      folder: defaultFolder,
      fileName: defaultFileName,
      openAfterExport: preferences.openAfterExport ?? true,
    };
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Export Chat' });

    await this.renderSummary(contentEl);
    this.renderOptions(contentEl);
    this.renderDestinationInputs(contentEl);
    this.renderActions(contentEl);
  }

  private resolvePreferences(): ChatExportPreferences {
    return this.plugin.settings.chatExportPreferences ?? {
      options: createDefaultChatExportOptions(),
    };
  }

  private async renderSummary(container: HTMLElement): Promise<void> {
    try {
      const result = await this.chatView.exportChat(this.state.options);
      const { summary } = result.context;

      container.createEl('h3', { text: 'Conversation Summary' });

      const totalsSetting = new Setting(container)
        .setName('Messages')
        .setDesc(`${summary.totalMessages} total · ${summary.assistantMessages} assistant · ${summary.userMessages} user`);

      totalsSetting.settingEl.classList.add('setting-item--no-control');

      const detailLines: string[] = [];
      if (summary.toolMessages > 0) {
        detailLines.push(`Tool messages: ${summary.toolMessages}`);
      }
      if (summary.toolCallCount > 0) {
        detailLines.push(`Tool calls: ${summary.toolCallCount}`);
      }
      if (summary.reasoningBlockCount > 0) {
        detailLines.push(`Reasoning blocks: ${summary.reasoningBlockCount}`);
      }
      if (summary.imageCount > 0) {
        detailLines.push(`Images referenced: ${summary.imageCount}`);
      }

      if (detailLines.length > 0) {
        const detailsList = container.createEl('ul');
        detailLines.forEach((text) => {
          detailsList.createEl('li', { text });
        });
      }
    } catch (error) {
      errorLogger.warn('Failed to render chat summary for export modal', {
        source: 'ChatExportModal',
        method: 'renderSummary',
        metadata: {
          chatId: this.chatView.chatId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private renderOptions(container: HTMLElement): void {
    container.createEl('h3', { text: 'Include Sections' });

    const groups: Array<{ label: string; keys: Array<{ key: keyof ChatExportOptions; label: string; description?: string }> }> = [
      {
        label: 'Overview',
        keys: [
          { key: 'includeMetadata', label: 'Metadata', description: 'Chat title, timestamps, model, and tool statistics.' },
          { key: 'includeSystemPrompt', label: 'System prompt', description: 'Export the active system prompt content.' },
          { key: 'includeContextFiles', label: 'Context files', description: 'Reference linked files and attachments.' },
        ],
      },
      {
        label: 'Conversation',
        keys: [
          { key: 'includeConversation', label: 'Conversation history', description: 'Include the message transcript.' },
          { key: 'includeUserMessages', label: 'User messages' },
          { key: 'includeAssistantMessages', label: 'Assistant messages' },
          { key: 'includeToolMessages', label: 'Tool responses' },
        ],
      },
      {
        label: 'Details',
        keys: [
          { key: 'includeReasoning', label: 'Reasoning traces', description: 'Show hidden reasoning callouts when available.' },
          { key: 'includeToolCalls', label: 'Tool call details', description: 'Include callouts for each tool invocation.' },
          { key: 'includeToolCallArguments', label: 'Tool arguments', description: 'Attach JSON arguments supplied to each tool call.' },
          { key: 'includeToolCallResults', label: 'Tool results', description: 'Attach JSON responses returned by tools.' },
          { key: 'includeContextFileContents', label: 'Context file contents', description: 'Embed the contents of referenced files.' },
          { key: 'includeImages', label: 'Image references', description: 'Render linked images in the export.' },
        ],
      },
    ];

    groups.forEach((group) => {
      container.createEl('h4', { text: group.label });

      group.keys.forEach((option) => {
        const setting = new Setting(container)
          .setName(option.label);

        if (option.description) {
          setting.setDesc(option.description);
        }

        setting.addToggle((toggle) => {
          toggle
            .setValue(!!this.state.options[option.key])
            .onChange((value) => {
              this.state.options = {
                ...this.state.options,
                [option.key]: value,
              };
            });
        });
      });
    });
  }

  private renderDestinationInputs(container: HTMLElement): void {
    container.createEl('h3', { text: 'Destination' });

    const folderSetting = new Setting(container)
      .setName('Folder')
      .setDesc('Vault folder where the exported note will be created.');

    folderSetting.addText((text) => {
      text.setPlaceholder('Folder path');
      text.setValue(this.state.folder);
      attachFolderSuggester(text.inputEl, (folder) => {
        text.setValue(folder);
      }, this.app);
      text.onChange((value) => {
        this.state.folder = value.trim();
      });
      this.folderInput = text.inputEl;
    });

    const fileSetting = new Setting(container)
      .setName('File name')
      .setDesc('Name of the exported markdown note (without extension).');

    fileSetting.addText((text) => {
      text.setPlaceholder('File name');
      text.setValue(this.state.fileName);
      text.onChange((value) => {
        this.state.fileName = value.trim();
      });
      this.fileNameInput = text.inputEl;
    });

    const openSetting = new Setting(container)
      .setName('Open after export')
      .setDesc('Open the new note immediately after it is created.');

    openSetting.addToggle((toggle) => {
      toggle
        .setValue(this.state.openAfterExport)
        .onChange((value) => {
          this.state.openAfterExport = value;
        });
      this.openAfterExportCheckbox = toggle.toggleEl.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    });
  }

  private renderActions(container: HTMLElement): void {
    const footer = container.createDiv({ cls: 'modal-button-container' });
    const cancelButton = footer.createEl('button', { text: 'Cancel' });
    const exportButton = footer.createEl('button', { text: 'Export' });
    exportButton.addClass('mod-cta');

    cancelButton.addEventListener('click', () => this.close());
    exportButton.addEventListener('click', async () => {
      await this.handleExport(exportButton);
    });
  }

  private async handleExport(button: HTMLButtonElement): Promise<void> {
    const folder = (this.folderInput?.value || this.state.folder || '').trim() || this.plugin.settings.chatsDirectory;
    const rawFileName = (this.fileNameInput?.value || this.state.fileName || '').trim();
    const sanitizedName = this.sanitizeFileName(rawFileName);

    if (!sanitizedName) {
      new Notice('Please enter a valid file name.');
      return;
    }

    const fullPath = `${folder}/${sanitizedName}.md`;

    try {
      button.setAttribute('disabled', 'true');
      await this.ensureFolder(folder);

      const existing = this.app.vault.getAbstractFileByPath(fullPath);
      if (existing instanceof TFile) {
        new Notice('File already exists. Choose a different name.');
        return;
      }

      const result = await this.chatView.exportChat(this.state.options);
      await this.app.vault.create(fullPath, result.markdown);

      errorLogger.info('Chat exported to markdown', {
        source: 'ChatExportModal',
        method: 'handleExport',
        metadata: {
          chatId: this.chatView.chatId,
          path: fullPath,
          options: this.state.options,
        },
      });

      new Notice(`Chat exported to "${sanitizedName}.md"`, 6000);

      if (this.state.openAfterExport) {
        const file = this.app.vault.getAbstractFileByPath(fullPath);
        if (file instanceof TFile) {
          await this.app.workspace.openLinkText(file.path, '', true);
        }
      }

      await this.persistPreferences(folder, sanitizedName);
      this.close();
    } catch (error) {
      errorLogger.error('Failed to export chat', error instanceof Error ? error : undefined, {
        source: 'ChatExportModal',
        method: 'handleExport',
        metadata: {
          chatId: this.chatView.chatId,
          path: fullPath,
        },
      });
      new Notice('Failed to export chat.', 6000);
    } finally {
      button.removeAttribute('disabled');
    }
  }

  private async ensureFolder(folder: string): Promise<void> {
    if (this.plugin.directoryManager) {
      await this.plugin.directoryManager.ensureDirectoryByPath(folder);
      return;
    }
    await this.app.vault.createFolder(folder).catch(() => {});
  }

  private sanitizeFileName(name: string): string {
    const base = name || this.generateDefaultFileName();
    return base.replace(/[/\\?%*:|"<>]/g, '').trim();
  }

  private generateDefaultFileName(): string {
    const title = sanitizeChatTitle(this.chatView.getChatTitle() || 'Chat Export');
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    return `${date} ${hour}-${minute} - ${title}`;
  }

  private async persistPreferences(folder: string, fileName: string): Promise<void> {
    const preferences: ChatExportPreferences = {
      options: { ...this.state.options },
      lastFolder: folder,
      openAfterExport: this.state.openAfterExport,
      lastFileName: fileName,
    };

    await this.plugin.getSettingsManager().updateSettings({
      chatExportPreferences: preferences,
    });
  }
}
