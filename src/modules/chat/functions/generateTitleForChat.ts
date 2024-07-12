import { App, TFile } from 'obsidian';
import { BrainModule } from '../../brain/BrainModule';
import { showCustomNotice, hideCustomNotice } from '../../../modals';
import { TitleEditModal } from '../views/TitleEditModal';
import { logger } from '../../../utils/logger';

export async function generateTitleForChat(
  app: App,
  chatFile: TFile,
  brainModule: BrainModule,
  updateChatTitle: (title: string) => void
) {
  if (!chatFile) return;
  const noteContent = await app.vault.read(chatFile);
  const notice = showCustomNotice('Generating Title...', 0, true);

  try {
    const generatedTitle = await brainModule.generateTitle(noteContent);
    if (generatedTitle) {
      await saveTitleEdit(app, chatFile, generatedTitle);
      updateChatTitle(generatedTitle);
    }
    showCustomNotice('Title generated successfully!');
  } catch (error) {
    logger.error('Error generating title:', error);
    showCustomNotice(`Title generation failed: ${error.message}`);
  } finally {
    hideCustomNotice();
  }
}

export function toggleEditTitle(
  app: App,
  chatFile: TFile,
  currentTitle: string,
  updateChatTitle: (title: string) => void
) {
  new TitleEditModal(app, currentTitle, async (newTitle: string) => {
    await saveTitleEdit(app, chatFile, newTitle);
    updateChatTitle(newTitle);
  }).open();
}

export async function saveTitleEdit(
  app: App,
  chatFile: TFile,
  newTitle: string
) {
  if (newTitle && chatFile) {
    const newFilePath = `${chatFile.parent?.path}/${newTitle}.md`;
    await app.fileManager.renameFile(chatFile, newFilePath);
  }
}

export function updateChatTitle(containerEl: HTMLElement, title: string) {
  const titleEl = containerEl.querySelector('.chat-title-text') as HTMLElement;
  if (titleEl) {
    titleEl.textContent = title;
  }
}
