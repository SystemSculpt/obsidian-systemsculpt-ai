import { RecorderModule } from '../RecorderModule';

export function updateRecorderButtonStatusBar(plugin: RecorderModule): void {
  if (plugin.plugin.recorderToggleStatusBarItem) {
    if (plugin.settings.showRecorderButtonOnStatusBar) {
      plugin.plugin.recorderToggleStatusBarItem.style.display = 'inline-block';
    } else {
      plugin.plugin.recorderToggleStatusBarItem.style.display = 'none';
    }
  }
}
