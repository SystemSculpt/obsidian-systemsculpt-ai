import { BrainModule } from '../BrainModule';
import { MarkdownView, TFile } from 'obsidian';
import { GeneratingTitleModal } from '../../../modals';

export async function generateTitleForCurrentNote(
  plugin: BrainModule
): Promise<void> {
  const activeView =
    plugin.plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (activeView) {
    const currentFile = activeView.file;
    if (!currentFile) {
      console.error('No file is currently active.');
      return;
    }
    const noteContent = await plugin.plugin.app.vault.read(currentFile);

    const generatingTitleModal = new GeneratingTitleModal(plugin.plugin.app);
    generatingTitleModal.open();

    try {
      const generatedTitle = await plugin.generateTitle(noteContent);
      await renameCurrentNote(plugin, currentFile, generatedTitle);
    } catch (error) {
      console.error('Error generating title:', error);
      throw new Error(
        'Failed to generate title. Please check your API key and try again.'
      );
    } finally {
      generatingTitleModal.close();
    }
  }
}

async function renameCurrentNote(
  plugin: BrainModule,
  currentFile: TFile,
  newTitle: string
): Promise<void> {
  if (!currentFile.parent) {
    console.error('The current file does not have a parent directory.');
    return;
  }
  const newPath = `${currentFile.parent.path}/${newTitle}.md`;
  await plugin.plugin.app.fileManager.renameFile(currentFile, newPath);
}
