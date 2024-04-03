import { App, PluginSettingTab, Setting } from 'obsidian';
import SystemSculptPlugin from '../../main';

export interface TemplatesSettings {
  // Define your templates settings here
}

const DEFAULT_TEMPLATES_SETTINGS: TemplatesSettings = {
  // Define your default templates settings here
};

export class TemplatesModule {
  plugin: SystemSculptPlugin;
  settings: TemplatesSettings;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
  }

  async load() {
    await this.loadSettings();
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_TEMPLATES_SETTINGS,
      await this.plugin.loadData()
    );
  }

  async saveSettings() {
    await this.plugin.saveData(this.settings);
  }

  settingsDisplay(containerEl: HTMLElement): void {
    new TemplatesSettingTab(this.plugin.app, this, containerEl).display();
  }
}

class TemplatesSettingTab extends PluginSettingTab {
  plugin: TemplatesModule;

  constructor(app: App, plugin: TemplatesModule, containerEl: HTMLElement) {
    super(app, plugin.plugin);
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();
    const templatesSettingsH3 = containerEl.createEl('h3', {
      text: 'Templates Settings',
    });
    templatesSettingsH3.addClass('ss-h3');

    containerEl.createEl('p', {
      text: 'Coming soon...',
    });

    // Upcoming Features
    const upcomingFeaturesEl = containerEl.createDiv('upcoming-features');
    const upcomingFeaturesH3 = upcomingFeaturesEl.createEl('h3', {
      text: 'Upcoming Templates Features',
    });
    upcomingFeaturesH3.addClass('ss-h3');
    const featuresListEl = upcomingFeaturesEl.createEl('ul');
    featuresListEl.createEl('li', {
      text: 'Create complex templates that can perform multiple GPT actions within a single run',
    });
    featuresListEl.createEl('li', {
      text: 'Use templates on an entire note or a selected portion of it with a single hotkey',
    });
    featuresListEl.createEl('li', {
      text: 'Complex AI as well as JavaScript actions able to be done through scripting (automations, for example)',
    });
  }
}
