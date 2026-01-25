import { App, Notice, TFile } from "obsidian";
import { showPopup } from "../core/ui";

// Maximum file size for uploads (500MB)
export const MAX_FILE_SIZE = 500 * 1024 * 1024;

/**
 * Validates file size and shows appropriate error messages
 * @param file The file to validate
 * @param app The Obsidian app instance
 * @returns True if file is valid, false otherwise
 */
export async function validateFileSize(file: TFile, app: App): Promise<boolean> {
  // Get file size
  const fileSize = file.stat.size;

  // Check if file is too large
  if (fileSize > MAX_FILE_SIZE) {

    // Show popup warning for non-audio files
    await showPopup(
      app,
      `The file "${file.name}" is too large (${formatFileSize(fileSize)}). The maximum allowed size is 500MB.`,
      {
        title: "File Size Limit Exceeded",
        description: "Please reduce the file size or choose a smaller file.",
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
export async function validateBrowserFileSize(file: File, app: App): Promise<boolean> {
  if (file.size > MAX_FILE_SIZE) {

    // Show popup warning for non-audio files
    await showPopup(
      app,
      `The file "${file.name}" is too large (${formatFileSize(file.size)}). The maximum allowed size is 500MB.`,
      {
        title: "File Size Limit Exceeded",
        description: "Please reduce the file size or choose a smaller file.",
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