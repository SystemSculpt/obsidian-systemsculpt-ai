import { App, PluginSettingTab, Setting } from 'obsidian';
import { TasksModule } from '../TasksModule';
import { renderTaskPromptSetting } from './TaskPromptSetting';
import { renderTasksLocationSetting } from './TasksLocationSetting';

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
    const tasksSettingsH3 = containerEl.createEl('h3', {
      text: 'Tasks Settings',
    });
    tasksSettingsH3.addClass('ss-h3');
    containerEl.createEl('p', {
      text: 'Tasks-specific settings such as the task prompt and the location of the task list.',
    });

    renderTaskPromptSetting(containerEl, this.plugin);
    renderTasksLocationSetting(containerEl, this.plugin);

    // Upcoming Features
    const upcomingFeaturesEl = containerEl.createDiv('upcoming-features');
    const upcomingTasksFeaturesH3 = upcomingFeaturesEl.createEl('h3', {
      text: 'Upcoming Tasks Features',
    });
    upcomingTasksFeaturesH3.addClass('ss-h3');
    const featuresListEl = upcomingFeaturesEl.createEl('ul');
    featuresListEl.createEl('li', {
      text: 'Ability to use SystemSculpt Recorder while making a new task, allowing you to speak your task instead of typing it',
    });
    featuresListEl.createEl('li', {
      text: 'Auto-sorting tasks based on custom / AI-generated categories and projects (examples: Groceries List, Meeting With Mike, Reading List, Patio Project)',
    });
    featuresListEl.createEl('li', {
      text: "Option to merge the Tasks list into the user's Daily Note instead of a separate Tasks file",
    });
  }
}
