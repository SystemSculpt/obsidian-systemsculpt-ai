import { App, PluginSettingTab, Setting } from "obsidian";
import { AnkiModule } from "../AnkiModule";
import { renderAnkiDirectorySetting } from "./AnkiDirectorySetting";

export class AnkiSettingTab extends PluginSettingTab {
  plugin: AnkiModule;

  constructor(app: App, plugin: AnkiModule, containerEl: HTMLElement) {
    super(app, plugin.plugin);
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Anki").setHeading();

    containerEl.createEl("p", {
      text: "Configure your Anki integration settings here.",
    });

    renderAnkiDirectorySetting(containerEl, this.plugin);
  }
}
