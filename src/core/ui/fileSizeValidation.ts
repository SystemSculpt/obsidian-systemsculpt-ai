import type { App } from "obsidian";
import { formatFileSize, MAX_FILE_SIZE } from "../../utils/FileValidator";
import { showPrompt } from "./modals/PromptModal";

type FileSizeValidationOptions = {
  maxBytes?: number;
  maxLabel?: string;
  title?: string;
  description?: string;
};

const DEFAULT_POPUP_TITLE = "File Size Limit Exceeded";
const DEFAULT_POPUP_DESCRIPTION =
  "Please reduce the file size or choose a smaller file.";

export async function validateBrowserFileSize(
  file: File,
  app: App,
  options: FileSizeValidationOptions = {},
): Promise<boolean> {
  const { name, size } = file;
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
