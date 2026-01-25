import { App, Notice } from "obsidian";

let uiReady = false;
const pendingNotices: { message: string; options: NotificationOptions }[] = [];

/**
 * Call this once during plugin initialization to enable queued notices.
 */
export function initializeNotificationQueue(app: App) {
  app.workspace.onLayoutReady(() => {
    uiReady = true;
    for (const { message, options } of pendingNotices) {
      new Notice(message, options.duration ?? 4000);
    }
    pendingNotices.length = 0;
  });
}

/**
 * Show a notice immediately if UI is ready, else queue it to show after layout.
 */
export function showNoticeWhenReady(app: App, message: string, options: NotificationOptions = {}) {
  if (uiReady) {
    new Notice(message, options.duration ?? 4000);
  } else {
    pendingNotices.push({ message, options });
  }
}
import { showPopup } from "./modals/PopupModal";

interface NotificationOptions {
  type?: "success" | "error" | "warning" | "info";
  duration?: number;
  icon?: string;
}

interface AlertOptions {
  title?: string;
  primaryButton?: string;
  secondaryButton?: string;
  icon?: string;
  type?: "error" | "warning" | "info";
}

/**
 * Show a quick notification for non-critical information
 */

/**
 * Show an alert popup for important messages that need user attention
 */
export async function showAlert(
  app: App,
  message: string,
  options: AlertOptions = {}
): Promise<{ confirmed: boolean }> {
  const {
    title = options.type === "error"
      ? "Error"
      : options.type === "warning"
      ? "Warning"
      : "Alert",
    primaryButton = "OK",
    secondaryButton,
    icon = options.type === "error"
      ? "alert-circle"
      : options.type === "warning"
      ? "alert-triangle"
      : "info",
  } = options;

  const result = await showPopup(app, message, {
    title,
    primaryButton,
    secondaryButton,
    icon,
  });

  return { confirmed: result?.confirmed || false };
}

/**
 * Show a confirmation popup for actions that need user approval
 */
export async function showConfirm(
  app: App,
  message: string,
  options: AlertOptions = {}
): Promise<{ confirmed: boolean }> {
  const {
    title = "Confirm Action",
    primaryButton = "Confirm",
    secondaryButton = "Cancel",
    icon = "help-circle",
  } = options;

  const result = await showPopup(app, message, {
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
export function displayNotice(app: App, parts: { title: string; path?: string; message?: string }, options: NotificationOptions = {}) {
  const fragment = document.createDocumentFragment();

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
