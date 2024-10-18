import { App, PluginSettingTab, Setting, TFolder } from "obsidian";
import { BuilderModule } from "../BuilderModule";
import { DEFAULT_BUILDER_SETTINGS } from "./BuilderSettings";
import { MultiSuggest } from "../../../utils/MultiSuggest";

export class BuilderSettingTab extends PluginSettingTab {
  plugin: BuilderModule;

  constructor(app: App, plugin: BuilderModule, containerEl: HTMLElement) {
    super(app, plugin.plugin);
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();
    new Setting(containerEl).setName("Builder").setHeading();

    containerEl.createEl("p", {
      text: "Configure settings for the Builder module.",
    });

    this.renderBuilderCanvasDirectorySetting(containerEl);
  }

  private renderBuilderCanvasDirectorySetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Builder Canvas Directory")
      .setDesc("Path where the Builder canvases will be stored")
      .addText((text) => {
        text
          .setPlaceholder("Enter path")
          .setValue(this.plugin.settings.builderCanvasDirectory)
          .onChange(async (value) => {
            this.plugin.settings.builderCanvasDirectory = value;
            await this.plugin.saveSettings();
          });

        // Add folder suggestion
        const inputEl = text.inputEl;
        const suggestionContent = this.getFolderSuggestions();
        const onSelectCallback = (selectedPath: string) => {
          this.plugin.settings.builderCanvasDirectory = selectedPath;
          text.setValue(selectedPath);
          this.plugin.saveSettings();
        };

        new MultiSuggest(
          inputEl,
          suggestionContent,
          onSelectCallback,
          this.plugin.plugin.app
        );
      })
      .addExtraButton((button) => {
        button
          .setIcon("reset")
          .setTooltip("Reset to default path")
          .onClick(async () => {
            this.plugin.settings.builderCanvasDirectory =
              DEFAULT_BUILDER_SETTINGS.builderCanvasDirectory;
            await this.plugin.saveSettings();
            this.display();
          });
      });
  }

  private getFolderSuggestions(): Set<string> {
    const folders = this.plugin.plugin.app.vault
      .getAllLoadedFiles()
      .filter((file) => file instanceof TFolder) as TFolder[];
    const suggestionContent = new Set(folders.map((folder) => folder.path));
    return suggestionContent;
  }
}
