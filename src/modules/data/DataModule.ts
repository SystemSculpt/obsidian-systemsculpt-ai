import { App, PluginSettingTab, Setting } from 'obsidian';
import SystemSculptPlugin from '../../main';

export interface DataSettings {
  // Define your data settings here
}

const DEFAULT_DATA_SETTINGS: DataSettings = {
  // Define your default data settings here
};

export class DataModule {
  plugin: SystemSculptPlugin;
  settings: DataSettings;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
  }

  async load() {
    await this.loadSettings();
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_DATA_SETTINGS,
      await this.plugin.loadData()
    );
  }

  async saveSettings() {
    await this.plugin.saveData(this.settings);
  }

  settingsDisplay(containerEl: HTMLElement): void {
    new DataSettingTab(this.plugin.app, this, containerEl).display();
  }
}

class DataSettingTab extends PluginSettingTab {
  plugin: DataModule;

  constructor(app: App, plugin: DataModule, containerEl: HTMLElement) {
    super(app, plugin.plugin);
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();
    const dataSettingsH3 = containerEl.createEl('h3', {
      text: 'Data Settings',
    });
    dataSettingsH3.addClass('ss-h3');

    containerEl.createEl('p', {
      text: 'Coming soon...',
    });

    // Upcoming Features
    const upcomingFeaturesEl = containerEl.createDiv('upcoming-features');
    const upcomingDataFeaturesH3 = upcomingFeaturesEl.createEl('h3', {
      text: 'Upcoming Data Features',
    });
    upcomingDataFeaturesH3.addClass('ss-h3');
    const featuresListEl = upcomingFeaturesEl.createEl('ul');
    featuresListEl.createEl('li', {
      text: 'A SystemSculpt Chrome extension to streamline the syncing of articles, tweets, youtube videos, and much more',
    });
    featuresListEl.createEl('li', {
      text: 'Omnivore / Readwise / Reader API integrations',
    });
    featuresListEl.createEl('li', {
      text: 'Have a cool data source that has an API that I can connect the SystemSculpt data route to? Message me on X or email!',
    });
  }
}
