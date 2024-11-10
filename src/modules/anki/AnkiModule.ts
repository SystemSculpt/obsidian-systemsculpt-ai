import { Notice } from "obsidian";
import SystemSculptPlugin from "../../main";
import { AnkiSettings, DEFAULT_ANKI_SETTINGS } from "./settings/AnkiSettings";
import { AnkiSettingTab } from "./settings/AnkiSettingTab";
import { logModuleLoadTime } from "../../utils/timing";
import { createAnkiCard } from "./functions/createAnkiCard";
import { studyAnkiCard } from "./functions/studyAnkiCard";

export class AnkiModule {
  plugin: SystemSculptPlugin;
  settings: AnkiSettings;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = DEFAULT_ANKI_SETTINGS;
  }

  async load() {
    const startTime = performance.now();
    await this.loadSettings();

    // Register the commands
    this.plugin.addCommand({
      id: "create-anki-card",
      name: "Create Anki Card from Note",
      callback: () => createAnkiCard(this),
    });

    this.plugin.addCommand({
      id: "study-anki-card",
      name: "Study Current Anki Card",
      callback: () => studyAnkiCard(this),
    });

    logModuleLoadTime("Anki", startTime);
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_ANKI_SETTINGS,
      await this.plugin.loadData()
    );
  }

  async saveSettings() {
    await this.plugin.saveSettings(this.settings);
  }

  settingsDisplay(containerEl: HTMLElement): void {
    new AnkiSettingTab(this.plugin.app, this, containerEl).display();
  }
}
