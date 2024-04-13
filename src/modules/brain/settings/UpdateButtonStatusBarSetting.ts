import { Setting } from 'obsidian';
import { BrainModule } from '../BrainModule';

export function renderUpdateButtonStatusBarSetting(
  containerEl: HTMLElement,
  plugin: BrainModule
): void {
  new Setting(containerEl)
    .setName('Show Update button on status bar')
    .setDesc('Toggle the display of the Update button on the status bar')
    .addToggle(toggle => {
      toggle
        .setValue(plugin.settings.showUpdateButtonInStatusBar)
        .onChange(async value => {
          plugin.settings.showUpdateButtonInStatusBar = value;
          if (plugin.plugin.updateStatusBarItem) {
            if (value) {
              plugin.plugin.updateStatusBarItem.style.display = 'inline-block';
            } else {
              plugin.plugin.updateStatusBarItem.style.display = 'none';
            }
          }
          await plugin.saveSettings();
        });
    });
}
