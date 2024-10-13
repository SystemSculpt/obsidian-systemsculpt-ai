import { TasksModule } from "../TasksModule";

export function updateTaskButtonStatusBar(plugin: TasksModule): void {
  if (plugin.plugin.taskToggleStatusBarItem) {
    if (plugin.settings.showTaskButtonOnStatusBar) {
      plugin.plugin.taskToggleStatusBarItem.removeClass("hidden");
    } else {
      plugin.plugin.taskToggleStatusBarItem.addClass("hidden");
    }
  }
}
