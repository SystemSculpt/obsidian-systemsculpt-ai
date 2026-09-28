import { App, TFile } from "obsidian";
import { showPrompt } from "../core/ui/modals/PromptModal";

// Maximum file size for uploads (500 MiB)
export const MAX_FILE_SIZE = 500 * 1024 * 1024;

export interface FileSizeValidationOptions {
  maxBytes?: number;
  maxLabel?: string;
  title?: string;
  description?: string;
}

const DEFAULT_POPUP_TITLE = "File Size Limit Exceeded";
const DEFAULT_POPUP_DESCRIPTION =
  "Please reduce the file size or choose a smaller file.";

export function validateFileSize(
  file: TFile,
  app: App,
  options: FileSizeValidationOptions = {},
): Promise<boolean> {
  return validateSize(file.name, file.stat.size, app, options);
}

export function validateBrowserFileSize(
  file: File,
  app: App,
  options: FileSizeValidationOptions = {},
): Promise<boolean> {
  return validateSize(file.name, file.size, app, options);
}

async function validateSize(
  name: string,
  size: number,
  app: App,
  options: FileSizeValidationOptions,
): Promise<boolean> {
  const maxBytes = options.maxBytes ?? MAX_FILE_SIZE;
  if (!(size > maxBytes)) return true;

  await showPrompt(
    app,
    `The file "${name}" is too large (${formatFileSize(size)}). The maximum allowed size is ${options.maxLabel ?? formatFileSize(maxBytes)}.`,
    {
      title: options.title ?? DEFAULT_POPUP_TITLE,
      description: options.description ?? DEFAULT_POPUP_DESCRIPTION,
      primaryButton: "OK",
    },
  );
  return false;
}

/**
 * Formats file size in a human-readable format
 * @param bytes File size in bytes
 * @returns Formatted file size string
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return bytes + " bytes";
  } else if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + " KiB";
  } else {
    return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
  }
}
