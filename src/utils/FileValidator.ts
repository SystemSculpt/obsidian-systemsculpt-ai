import { App, TFile } from "obsidian";
import { showPopup } from "../core/ui";

// Maximum file size for uploads (500MB)
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

const resolveMaxLabel = (maxBytes: number, maxLabel?: string): string =>
  maxLabel ?? formatFileSize(maxBytes);

/**
 * Validates file size and shows appropriate error messages
 * @param file The file to validate
 * @param app The Obsidian app instance
 * @returns True if file is valid, false otherwise
 */
export async function validateFileSize(
  file: TFile,
  app: App,
  options: FileSizeValidationOptions = {}
): Promise<boolean> {
  // Get file size
  const fileSize = file.stat.size;
  const maxBytes = options.maxBytes ?? MAX_FILE_SIZE;

  // Check if file is too large
  if (fileSize > maxBytes) {
    const maxLabel = resolveMaxLabel(maxBytes, options.maxLabel);

    // Show popup warning for non-audio files
    await showPopup(
      app,
      `The file "${file.name}" is too large (${formatFileSize(fileSize)}). The maximum allowed size is ${maxLabel}.`,
      {
        title: options.title ?? DEFAULT_POPUP_TITLE,
        description: options.description ?? DEFAULT_POPUP_DESCRIPTION,
        primaryButton: "OK",
      }
    );
    return false;
  }

  return true;
}

/**
 * Validates file size for a browser File object
 * @param file The browser File object
 * @param app The Obsidian app instance
 * @returns True if file is valid, false otherwise
 */
export async function validateBrowserFileSize(
  file: File,
  app: App,
  options: FileSizeValidationOptions = {}
): Promise<boolean> {
  const maxBytes = options.maxBytes ?? MAX_FILE_SIZE;
  if (file.size > maxBytes) {
    const maxLabel = resolveMaxLabel(maxBytes, options.maxLabel);

    // Show popup warning for non-audio files
    await showPopup(
      app,
      `The file "${file.name}" is too large (${formatFileSize(file.size)}). The maximum allowed size is ${maxLabel}.`,
      {
        title: options.title ?? DEFAULT_POPUP_TITLE,
        description: options.description ?? DEFAULT_POPUP_DESCRIPTION,
        primaryButton: "OK",
      }
    );
    return false;
  }

  return true;
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
    return (bytes / 1024).toFixed(1) + " KB";
  } else {
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
}
