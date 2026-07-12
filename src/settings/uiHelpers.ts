import { setIcon } from "obsidian";

export interface ExternalHelpLinkOptions {
  text: string;
  href: string;
  className?: string;
  ariaLabel?: string;
  datasetTestId?: string;
}

const RESTORE_DEFAULTS_DESCRIPTION = "Restore the recommended defaults";
const RESTORE_DEFAULTS_LABEL = "Restore Recommended Defaults";

export function createExternalHelpLink(container: HTMLElement, options: ExternalHelpLinkOptions): HTMLAnchorElement {
  const link = document.createElement("a");
  link.textContent = options.text;
  link.href = options.href;
  link.classList.add("ss-help-link");
  if (options.className) {
    link.classList.add(options.className);
  }
  link.target = "_blank";
  link.rel = "noopener";

  const ariaLabel = options.ariaLabel ?? `${options.text} (opens in new tab)`;
  link.setAttribute("aria-label", ariaLabel);
  link.title = ariaLabel;

  if (options.datasetTestId) {
    link.dataset.testId = options.datasetTestId;
  }

  const icon = document.createElement("span");
  icon.classList.add("ss-help-link-icon");
  setIcon(icon, "external-link");
  link.appendChild(icon);

  container.appendChild(link);
  return link;
}

export function decorateRestoreDefaultsButton(button: HTMLButtonElement): HTMLButtonElement {
  button.textContent = RESTORE_DEFAULTS_LABEL;
  button.setAttribute("aria-label", RESTORE_DEFAULTS_DESCRIPTION);
  button.title = RESTORE_DEFAULTS_DESCRIPTION;
  button.dataset.testId = "restore-defaults-btn";
  button.classList.add("ss-restore-defaults-btn");
  return button;
}

export const RESTORE_DEFAULTS_COPY = {
  description: RESTORE_DEFAULTS_DESCRIPTION,
  label: RESTORE_DEFAULTS_LABEL,
} as const;
