import { App, Notice } from "obsidian";
import { showPrompt } from "./modals/PromptModal";
import { createSurfaceFragment, resolveSurfaceDomContext } from "./surface";

interface NotificationOptions {
  duration?: number;
}

interface ConfirmOptions {
  title?: string;
  primaryButton?: string;
  secondaryButton?: string;
  icon?: string;
}

/**
 * Show a confirmation popup for actions that need user approval
 */
export async function showConfirm(
  app: App,
  message: string,
  options: ConfirmOptions = {}
): Promise<{ confirmed: boolean }> {
  const {
    title = "Confirm Action",
    primaryButton = "Confirm",
    secondaryButton = "Cancel",
    icon = "help-circle",
  } = options;

  const result = await showPrompt(app, message, {
    title,
    primaryButton,
    secondaryButton,
    icon,
  });

  return { confirmed: result?.confirmed || false };
}

/**
 * A more advanced notice that supports multi-line messages and custom styling.
 * @param app - The Obsidian App instance.
 * @param parts - An object containing the parts of the message.
 * @param options - Notification options.
 */
export function displayNotice(parts: { title: string; path?: string; message?: string }, options: NotificationOptions = {}) {
  const fragment = createSurfaceFragment(resolveSurfaceDomContext().document);

  // Title (e.g., "Switched to tab")
  const titleEl = fragment.createDiv({ cls: 'systemsculpt-notice-title' });
  titleEl.setText(parts.title);

  // Path (e.g., "path/to/your/file.md")
  if (parts.path) {
    const pathEl = fragment.createDiv({ cls: 'systemsculpt-notice-path' });
    pathEl.setText(parts.path);
  }

  // Message (e.g., "File is in another pane.")
  if (parts.message) {
    const messageEl = fragment.createDiv({ cls: 'systemsculpt-notice-message' });
    messageEl.setText(parts.message);
  }

  new Notice(fragment, options.duration ?? 5000);
}
