import { TasksModule } from "../TasksModule";

export function updateTaskButtonStatusBar(plugin: TasksModule): void {
  if (plugin.plugin.taskToggleStatusBarItem) {
    if (plugin.settings.showTaskButtonOnStatusBar) {
      plugin.plugin.taskToggleStatusBarItem.style.display = "inline-block";
    } else {
      plugin.plugin.taskToggleStatusBarItem.style.display = "none";
    }
  }
}
