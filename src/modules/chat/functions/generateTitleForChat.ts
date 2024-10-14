import { App, TFile } from "obsidian";
import { BrainModule } from "../../brain/BrainModule";
import { showCustomNotice } from "../../../modals";
import { TitleEditModal } from "../views/TitleEditModal";

export async function generateTitleForChat(
  app: App,
  chatFile: TFile,
  brainModule: BrainModule,
  updateChatTitle: (title: string) => void
) {
  if (!chatFile) return;
  const noteContent = await app.vault.read(chatFile);
  const notice = showCustomNotice("Generating Title...");

  try {
    const generatedTitle = await brainModule.generateTitle(noteContent);
    if (generatedTitle) {
      await saveTitleEdit(app, chatFile, generatedTitle);
      updateChatTitle(generatedTitle);
    }
    showCustomNotice("Title generated successfully!");
  } catch (error) {
    showCustomNotice(`Title generation failed: ${(error as Error).message}`);
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
  const titleEl = containerEl.querySelector(
    ".systemsculpt-chat-title-text"
  ) as HTMLElement;
  if (titleEl) {
    titleEl.textContent = title;
  }
}
