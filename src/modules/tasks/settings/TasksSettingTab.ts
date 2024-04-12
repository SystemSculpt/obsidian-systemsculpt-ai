import { App, PluginSettingTab, Setting } from 'obsidian';
import { TasksModule } from '../TasksModule';
import { renderTaskPromptSetting } from './TaskPromptSetting';
import { renderTasksLocationSetting } from './TasksLocationSetting';
import { updateTaskButtonStatusBar } from '../functions/updateTaskButtonStatusBar';

export class SystemSculptTasksSettingTab extends PluginSettingTab {
  plugin: TasksModule;

  constructor(app: App, plugin: TasksModule, containerEl: HTMLElement) {
    super(app, plugin.plugin);
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();
    new Setting(containerEl).setName('Tasks').setHeading();

    containerEl.createEl('p', {
      text: 'Tasks-specific settings such as the task prompt and the location of the task list.',
    });

    // Add toggle for showing Task Button on the status bar
    new Setting(containerEl)
      .setName('Show task button on status bar')
      .setDesc('Toggle the display of task button on the status bar')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.showTaskButtonOnStatusBar)
          .onChange(async value => {
            this.plugin.settings.showTaskButtonOnStatusBar = value;
            updateTaskButtonStatusBar(this.plugin);
            await this.plugin.saveSettings();
          });
      });

    renderTaskPromptSetting(containerEl, this.plugin);
    renderTasksLocationSetting(containerEl, this.plugin);
  }
}
