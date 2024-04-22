import { Setting } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { updateMaxTokensStatusBar } from '../functions/updateMaxTokensStatusBar';

export function renderShowMaxTokensOnStatusBarSetting(
  containerEl: HTMLElement,
  plugin: BrainModule
): void {
  new Setting(containerEl)
    .setName('Show max tokens on status bar')
    .setDesc('Toggle the display of max tokens on the status bar')
    .addToggle(toggle => {
      toggle
        .setValue(plugin.settings.showMaxTokensOnStatusBar)
        .onChange(async value => {
          plugin.settings.showMaxTokensOnStatusBar = value;
          if (value) {
            updateMaxTokensStatusBar(plugin);
          } else if (plugin.plugin.maxTokensToggleStatusBarItem) {
            plugin.plugin.maxTokensToggleStatusBarItem.setText('');
          }
          await plugin.saveSettings();
        });
    });
}
