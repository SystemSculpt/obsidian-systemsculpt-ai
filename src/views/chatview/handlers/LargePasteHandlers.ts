import { App, Modal, Notice, TFile } from "obsidian";
import type SystemSculptPlugin from "../../../main";
import { validateBrowserFileSize } from "../../../utils/FileValidator";
import { LARGE_TEXT_MESSAGES, LargeTextHelpers } from "../../../constants/largeText";

const IMAGE_PASTE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

const isClipboardImageFile = (file: File): boolean => {
  if (!file) return false;
  if (file.type && file.type.startsWith("image/")) return true;
  const name = file.name || "";
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : "";
  return !!ext && IMAGE_PASTE_EXTENSIONS.has(ext);
};

export interface LargePasteContext {
  app: App;
  plugin: SystemSculptPlugin;
  addFileToContext: (file: TFile) => Promise<void>;
  insertTextAtCursor: (text: string) => void;
  getPendingLargeTextContent: () => string | null;
  setPendingLargeTextContent: (text: string | null) => void;
}

export async function handleLargeTextPaste(ctx: LargePasteContext, text: string): Promise<void> {
  const lineCount = LargeTextHelpers.getLineCount(text);
  const placeholder = LargeTextHelpers.createPlaceholder(lineCount);

  ctx.setPendingLargeTextContent(text);
  ctx.insertTextAtCursor(placeholder);
  new Notice(`${LARGE_TEXT_MESSAGES.CONFIRMATION_PREFIX} (${lineCount} lines). Full content will be sent when you submit.`);
}

export function showLargeTextWarning(ctx: LargePasteContext, sizeKB: number, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(ctx.app);
    modal.titleEl.setText('Large Text Detected');

    const content = modal.contentEl;
    content.createEl('p', {
      text: `You're trying to paste ${Math.round(sizeKB)}KB of text. This might cause performance issues.`
    });

    const preview = content.createEl('div', { cls: 'systemsculpt-large-text-preview' });
    preview.createEl('p', { text: 'Preview (first 200 characters):' });
    preview.createEl('pre', {
      text: text.substring(0, 200) + (text.length > 200 ? '...' : ''),
      cls: 'systemsculpt-text-preview'
    });

    const buttonContainer = content.createDiv({ cls: 'systemsculpt-modal-buttons' });

    const proceedBtn = buttonContainer.createEl('button', { text: 'Proceed Anyway' });
    proceedBtn.addEventListener('click', () => {
      modal.close();
      resolve(true);
    });

    const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      modal.close();
      resolve(false);
    });

    modal.open();
  });
}

export async function handlePaste(ctx: LargePasteContext, e: ClipboardEvent): Promise<void> {
  const dt = e.clipboardData;
  if (!dt) return;

  const pastedText = dt.getData("text/plain") ?? "";
  const allFiles = Array.from(dt.files);
  const hasImageFiles = allFiles.some((file) => isClipboardImageFile(file));

  if (!allFiles.length && pastedText) {
    const warningLevel = LargeTextHelpers.getTextWarningLevel(pastedText);

    if (warningLevel === 'error') {
      e.preventDefault();
      new Notice(LARGE_TEXT_MESSAGES.SIZE_ERROR);
      return;
    } else if (warningLevel === 'hard') {
      e.preventDefault();
      const textSizeKB = LargeTextHelpers.getTextSizeKB(pastedText);
      const proceed = await showLargeTextWarning(ctx, textSizeKB, pastedText);
      if (!proceed) return;
      await handleLargeTextPaste(ctx, pastedText);
      return;
    } else if (warningLevel === 'soft') {
      const textSizeKB = LargeTextHelpers.getTextSizeKB(pastedText);
      new Notice(`${LARGE_TEXT_MESSAGES.SIZE_WARNING_PREFIX} (${LargeTextHelpers.formatSize(textSizeKB)}). Processing...`);
      // Fall through to default paste behavior
    }
    return;
  }

  e.preventDefault();
  if (!allFiles.length) {
    return;
  }

  for (const file of allFiles) {
    try {
      const isValidSize = await validateBrowserFileSize(file, ctx.app);
      if (!isValidSize) {
        continue;
      }

      let extension = "bin";
      if (file.name && file.name.includes(".")) {
        const dotIdx = file.name.lastIndexOf(".");
        if (dotIdx >= 0) {
          extension = file.name.substring(dotIdx + 1).toLowerCase();
        }
      } else if (file.type) {
        const mimeParts = file.type.split("/");
        if (mimeParts.length === 2) {
          extension = mimeParts[1].toLowerCase().replace(/[^a-z0-9]/g, "");
        }
      }

      const now = new Date();
      const isoString = now.toISOString().replace(/[:.]/g, "-");
      const newFileName = `pasted-${isoString}.${extension}`;

      const arrayBuffer = await file.arrayBuffer();

      const attachmentsDir = ctx.plugin.settings.attachmentsDirectory || "Attachments";
      const finalPath = `${attachmentsDir}/${newFileName}`;

      if ((ctx.plugin as any).directoryManager) {
        await (ctx.plugin as any).directoryManager.ensureDirectoryByPath(attachmentsDir);
      } else {
        await (ctx.plugin as any).createDirectory(attachmentsDir);
      }

      await ctx.app.vault.createBinary(finalPath, arrayBuffer);

      const createdFile = ctx.app.vault.getAbstractFileByPath(finalPath);
      if (createdFile instanceof TFile) {
        await ctx.addFileToContext(createdFile);
        new Notice(`Pasted file saved & added to context: ${createdFile.name}`);
      } else {
        throw new Error("Failed to locate pasted file in vault.");
      }
    } catch (err: any) {
      new Notice(`Failed to handle pasted file: ${err.message}`);
    }
  }

  if (pastedText && !hasImageFiles) {
    if (LargeTextHelpers.shouldCollapseInHistory(pastedText)) {
      await handleLargeTextPaste(ctx, pastedText);
    } else {
      ctx.insertTextAtCursor(pastedText);
    }
  }
}
