import { Setting } from "obsidian";
import { AnkiModule } from "../AnkiModule";
import { DEFAULT_ANKI_SETTINGS } from "./AnkiSettings";
import { MultiSuggest } from "../../../utils/MultiSuggest";
import { TFolder } from "obsidian";
export function renderAnkiDirectorySetting(
  containerEl: HTMLElement,
  plugin: AnkiModule
): void {
  new Setting(containerEl)
    .setName("Anki Directory")
    .setDesc("Directory where Anki-related files will be stored")
    .addText((text) => {
      text
        .setPlaceholder("SystemSculpt/Anki")
        .setValue(plugin.settings.ankiDirectory)
        .onChange(async (value) => {
          plugin.settings.ankiDirectory = value;
          await plugin.saveSettings();
        });

      const inputEl = text.inputEl;
      const suggestionContent = getFolderSuggestions(plugin);
      const onSelectCallback = (selectedPath: string) => {
        plugin.settings.ankiDirectory = selectedPath;
        text.setValue(selectedPath);
        plugin.saveSettings();
      };

      new MultiSuggest(
        inputEl,
        new Set(suggestionContent),
        onSelectCallback,
        plugin.plugin.app
      );
    })
    .addExtraButton((button) => {
      button
        .setIcon("reset")
        .setTooltip("Reset to default Anki directory")
        .onClick(async () => {
          plugin.settings.ankiDirectory = DEFAULT_ANKI_SETTINGS.ankiDirectory;
          await plugin.saveSettings();
          plugin.settingsDisplay(containerEl);
        });
    });
}

function getFolderSuggestions(plugin: AnkiModule): string[] {
  const folders: string[] = [];
  const files = plugin.plugin.app.vault.getAllLoadedFiles();

  files.forEach((file) => {
    if (file instanceof TFolder) {
      folders.push(file.path);
    }
  });

  return folders;
}
