import { App, Modal, Setting } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { updateMaxTokensStatusBar } from '../functions/updateMaxTokensStatusBar';
import { MarkdownView } from 'obsidian';

export class MaxTokensModal extends Modal {
  plugin: BrainModule;

  constructor(app: App, plugin: BrainModule) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    let { contentEl } = this;

    contentEl.createEl('h2', { text: 'Max tokens' });

    new Setting(contentEl)
      .setName('Max tokens')
      .setDesc(
        'The maximum number of tokens to generate in the chat completion'
      )
      .addText(text =>
        text
          .setPlaceholder('Enter max tokens')
          .setValue(this.plugin.settings.maxTokens.toString())
          .onChange(async (value: string) => {
            const maxTokens = parseInt(value);
            if (!isNaN(maxTokens) && maxTokens >= 1) {
              const correctedMaxTokens = Math.min(Math.max(maxTokens, 1), 4096);
              this.plugin.settings.maxTokens = correctedMaxTokens;
              await this.plugin.saveSettings();
              updateMaxTokensStatusBar(this.plugin);
            }
          })
          .inputEl.addEventListener('keydown', async (event: KeyboardEvent) => {
            if (event.key === 'Enter') {
              await this.plugin.saveSettings();
              this.close();
              const activeLeaf = this.plugin.plugin.app.workspace.activeLeaf;
              if (activeLeaf && activeLeaf.view.getViewType() === 'markdown') {
                const markdownView = activeLeaf.view as MarkdownView;
                markdownView.editor.focus();
              }
            }
          })
      );
  }

  onClose(): void {
    let { contentEl } = this;
    contentEl.empty();
  }
}
