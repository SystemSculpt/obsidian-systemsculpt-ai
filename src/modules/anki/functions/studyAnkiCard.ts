import { MarkdownView } from "obsidian";
import { AnkiModule } from "../AnkiModule";
import { showCustomNotice } from "../../../modals";
import { AnkiStudyModal } from "../views/AnkiStudyModal";

export async function studyAnkiCard(plugin: AnkiModule): Promise<void> {
  const activeView =
    plugin.plugin.app.workspace.getActiveViewOfType(MarkdownView);

  if (!activeView) {
    showCustomNotice("No active note found");
    return;
  }

  // @ts-ignore
  const noteContent = await plugin.plugin.app.vault.read(activeView.file);
  const modal = new AnkiStudyModal(plugin.plugin.app, plugin, noteContent);
  modal.open();
}
