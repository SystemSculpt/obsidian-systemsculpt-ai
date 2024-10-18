import SystemSculptPlugin from "../../main";
import {
  BuilderSettings,
  DEFAULT_BUILDER_SETTINGS,
} from "./settings/BuilderSettings";
import { BuilderSettingTab } from "./settings/BuilderSettingTab";
import { TFile, Notice } from "obsidian";

export class BuilderModule {
  plugin: SystemSculptPlugin;
  settings: BuilderSettings;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = DEFAULT_BUILDER_SETTINGS;
  }

  async load() {
    await this.loadSettings();
    this.addCommands();
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_BUILDER_SETTINGS,
      await this.plugin.loadData()
    );
  }

  async saveSettings() {
    await this.plugin.saveSettings(this.settings);
  }

  settingsDisplay(containerEl: HTMLElement): void {
    new BuilderSettingTab(this.plugin.app, this, containerEl).display();
  }

  private addCommands() {
    this.plugin.addCommand({
      id: "open-systemsculpt-ai-builder-canvas",
      name: "Open SystemSculpt AI Builder Canvas",
      callback: () => this.openBuilderCanvas(),
    });
  }

  private async openBuilderCanvas() {
    const fileName = `SystemSculpt AI Builder Canvas ${Date.now()}.canvas`;
    const filePath = `${this.settings.builderCanvasDirectory}/${fileName}`;

    // Ensure the directory exists
    await this.plugin.app.vault.adapter.mkdir(
      this.settings.builderCanvasDirectory
    );

    const file = await this.plugin.app.vault.create(filePath, "{}");

    if (file instanceof TFile) {
      const leaf = this.plugin.app.workspace.getLeaf(true);
      await leaf.openFile(file, { active: true });

      // Optionally, you can add some initial content to the canvas
      await this.initializeCanvasContent(file);

      new Notice("SystemSculpt AI Builder Canvas created");
    }
  }

  private async initializeCanvasContent(file: TFile) {
    const initialContent = {
      nodes: [],
      edges: [],
    };
    await this.plugin.app.vault.modify(
      file,
      JSON.stringify(initialContent, null, 2)
    );
  }
}
