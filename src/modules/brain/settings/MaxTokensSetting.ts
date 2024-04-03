import { Setting } from 'obsidian';
import { BrainModule } from '../BrainModule';

export function renderMaxTokensSetting(
  containerEl: HTMLElement,
  plugin: BrainModule
): void {
  new Setting(containerEl)
    .setName('Max Tokens')
    .setDesc('The maximum number of tokens to generate in the chat completion')
    .addText(text =>
      text
        .setPlaceholder('Enter max tokens')
        .setValue(plugin.settings.maxTokens.toString())
        .onChange(async (value: string) => {
          const maxTokens = parseInt(value);
          if (!isNaN(maxTokens)) {
            plugin.settings.maxTokens = maxTokens;
            await plugin.saveSettings();
          }
        })
    );
}
