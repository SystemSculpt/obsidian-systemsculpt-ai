import { Setting } from 'obsidian';
import { BrainModule } from '../BrainModule';

export function renderMaxTokensSetting(
  containerEl: HTMLElement,
  plugin: BrainModule
): void {
  new Setting(containerEl)
    .setName('Max tokens')
    .setDesc('The maximum number of tokens to generate in the chat completion')
    .addText(text =>
      text
        .setPlaceholder('Enter max tokens')
        .setValue(plugin.settings.maxTokens.toString())
        .onChange(async (value: string) => {
          const maxTokens = parseInt(value);
          if (!isNaN(maxTokens) && maxTokens >= 1) {
            const correctedMaxTokens = Math.min(Math.max(maxTokens, 1), 4096);
            plugin.settings.maxTokens = correctedMaxTokens;
            await plugin.saveSettings();
          }
        })
    );
  const infoBoxEl = containerEl.createDiv('info-box');
  infoBoxEl.createEl('p', {
    text: 'You can hotkey this (I personally hotkey it to CMD+Shift+M). It will open up a simple modal that you can change the max tokens on the fly with.',
  });
}
