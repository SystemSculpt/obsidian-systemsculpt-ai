import SystemSculptPlugin from '../../main';
import { BrainModule } from '../brain/BrainModule';
import {
  SystemSculptTasksSettings,
  DEFAULT_TASKS_SETTINGS,
} from './settings/TasksSettings';
import { SystemSculptTasksSettingTab } from './settings/TasksSettingTab';
import { viewTasks } from './functions/viewTasks';
import { TaskModal } from './views/TaskModal';
import { generateTask as generateTaskFunction } from './functions/generateTask';
import { insertGeneratedTask as insertGeneratedTaskFunction } from './functions/insertGeneratedTask';
import { updateTaskButtonStatusBar } from './functions/updateTaskButtonStatusBar';
import { MarkdownView } from 'obsidian';

export interface Task {
  description: string;
  subtasks: { description: string; completed: boolean }[];
  completed: boolean;
}

export class TasksModule {
  plugin: SystemSculptPlugin;
  brain: BrainModule;
  settings: SystemSculptTasksSettings;

  constructor(plugin: SystemSculptPlugin, brain: BrainModule) {
    this.plugin = plugin;
    this.brain = brain;
  }

  async load() {
    await this.loadSettings();

    this.plugin.addCommand({
      id: 'open-task-modal',
      name: 'Add task',
      callback: async () => {
        new TaskModal(this.plugin.app, this).open();
      },
    });

    this.plugin.addCommand({
      id: 'view-tasks',
      name: 'View tasks',
      callback: () => {
        this.viewTasks();
      },
    });

    // Initialize status bar for Task Button
    if (!this.plugin.taskToggleStatusBarItem) {
      this.plugin.taskToggleStatusBarItem = this.plugin.addStatusBarItem();
      this.plugin.taskToggleStatusBarItem.addClass('task-toggle-button');
      this.plugin.taskToggleStatusBarItem.setText('T'); // Set text to "T"
    }

    updateTaskButtonStatusBar(this); // Update the status bar on load

    // Add click listener to open the Task Modal
    this.plugin.taskToggleStatusBarItem.onClickEvent(async () => {
      new TaskModal(this.plugin.app, this).open();
    });
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_TASKS_SETTINGS,
      await this.plugin.loadData()
    );
  }

  async saveSettings() {
    await this.plugin.saveData(this.settings);
    updateTaskButtonStatusBar(this); // Update the status bar when settings are saved
  }

  settingsDisplay(containerEl: HTMLElement): void {
    new SystemSculptTasksSettingTab(
      this.plugin.app,
      this,
      containerEl
    ).display();
  }

  async viewTasks(): Promise<void> {
    const leaves = this.plugin.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const fileView = leaf.view as MarkdownView;
      if (fileView.file?.path === this.settings.tasksLocation) {
        this.plugin.app.workspace.revealLeaf(leaf);
        fileView.editor.focus(); // Set cursor focus to the active file
        return;
      }
    }
    return viewTasks(this);
  }

  async generateTask(taskDescription: string): Promise<string> {
    return generateTaskFunction(this, taskDescription);
  }

  async insertGeneratedTask(generatedTask: string): Promise<void> {
    return insertGeneratedTaskFunction(this, generatedTask);
  }
}
