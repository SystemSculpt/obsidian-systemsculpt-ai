import { App, PluginSettingTab, Setting } from "obsidian";
import SystemSculptPlugin from "../../main";
import { logModuleLoadTime } from "../../utils/timing";

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
    this.settings = DEFAULT_DATA_SETTINGS;
  }

  async load() {
    const startTime = performance.now();
    await this.loadSettings();
    logModuleLoadTime("Data", startTime);
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_DATA_SETTINGS,
      await this.plugin.loadData()
    );
  }

  async saveSettings() {
    await this.plugin.saveSettings(this.settings);
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
    new Setting(containerEl).setName("Data").setHeading();

    containerEl.createEl("p", {
      text: "Coming soon...",
    });
  }
}
