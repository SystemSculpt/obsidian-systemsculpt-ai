import { App, Notice } from "obsidian";
import { showPrompt } from "./modals/PromptModal";
import { createSurfaceFragment, getSurfaceOwnerWindow, resolveSurfaceDomContext } from "./surface";

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
 * One notice with a single follow-up action, such as the result of a check
 * the user asked for. Choosing the action dismisses the notice.
 */
export function showActionNotice(
  message: string,
  action: { label: string; onSelect: () => void },
  options: NotificationOptions = {},
): void {
  const fragment = createSurfaceFragment(resolveSurfaceDomContext().document);
  fragment.createDiv({ cls: "systemsculpt-notice-message", text: message });
  const button = fragment.createEl("button", {
    cls: "systemsculpt-notice-action mod-cta",
    text: action.label,
    attr: { type: "button", "data-testid": "notice.action" },
  });
  const notice = new Notice(fragment, options.duration ?? 10_000);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    notice.hide();
    action.onSelect();
  });
}

const BUTTON_RESULT_MS = 1_500;
const buttonResults = new WeakMap<HTMLElement, { label: string; timer: number }>();

/**
 * Show a short result such as "Copied" on the text button that started an
 * action, in place of a success notice, then restore the button's label.
 */
export function flashButtonResult(button: HTMLElement, result: string, durationMs = BUTTON_RESULT_MS): void {
  const labelEl = button.querySelector<HTMLElement>(".ss-button__label") ?? button;
  const ownerWindow = getSurfaceOwnerWindow(button);
  const pending = buttonResults.get(button);
  if (pending) ownerWindow.clearTimeout(pending.timer);
  const label = pending?.label ?? labelEl.textContent ?? "";
  labelEl.textContent = result;
  const timer = ownerWindow.setTimeout(() => {
    buttonResults.delete(button);
    labelEl.textContent = label;
  }, durationMs);
  buttonResults.set(button, { label, timer });
}
