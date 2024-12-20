import { RecorderModule } from "../RecorderModule";

export function updateRecorderButtonStatusBar(plugin: RecorderModule): void {
  if (plugin.plugin.recorderToggleStatusBarItem) {
    if (plugin.settings.showRecorderButtonOnStatusBar) {
      plugin.plugin.recorderToggleStatusBarItem.removeClass(
        "systemsculpt-hidden"
      );
    } else {
      plugin.plugin.recorderToggleStatusBarItem.addClass("systemsculpt-hidden");
    }
  }
}
