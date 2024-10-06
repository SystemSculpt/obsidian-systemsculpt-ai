import { BrainModule } from "../BrainModule";
import { MarkdownView, TFile } from "obsidian";
import { showCustomNotice } from "../../../modals";
import { ChatView } from "../../chat/ChatView";

export async function generateTitleForCurrentNote(
  plugin: BrainModule,
): Promise<void> {
  const activeView =
    plugin.plugin.app.workspace.getActiveViewOfType(MarkdownView);
  const activeChatView =
    plugin.plugin.app.workspace.getActiveViewOfType(ChatView);

  if (activeChatView) {
    await activeChatView.handleGenerateTitle();
    return;
  }

  if (activeView) {
    const currentFile = activeView.file;
    if (!currentFile) {
      return;
    }
    const noteContent = await plugin.plugin.app.vault.read(currentFile);

    const notice = showCustomNotice("Generating Title...");

    try {
      const generatedTitle = await plugin.generateTitle(noteContent);
      await renameCurrentNote(plugin, currentFile, generatedTitle);
      showCustomNotice("Title generated successfully!");
    } catch (error) {
      // @ts-ignore
      showCustomNotice(`Title generation failed: ${error.message}`);
      throw new Error(
        "Failed to generate title. Please check your API key and try again.",
      );
    } finally {
    }
  }
}

async function renameCurrentNote(
  plugin: BrainModule,
  currentFile: TFile,
  newTitle: string,
): Promise<void> {
  if (!currentFile.parent) {
    return;
  }
  const newPath = `${currentFile.parent.path}/${newTitle}.md`;
  await plugin.plugin.app.fileManager.renameFile(currentFile, newPath);
}
