import { setIcon } from "obsidian";

export interface ExternalHelpLinkOptions {
  text: string;
  href: string;
  className?: string;
  ariaLabel?: string;
  datasetTestId?: string;
}

export interface InlineExternalLinkNoteOptions {
  prefixText?: string;
  linkText: string;
  href: string;
  suffixText?: string;
  className?: string;
  linkClassName?: string;
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

export function createInlineExternalLinkNote(container: HTMLElement, options: InlineExternalLinkNoteOptions): HTMLDivElement {
  const note = document.createElement("div");
  note.classList.add("ss-inline-note");
  if (options.className) {
    note.classList.add(options.className);
  }

  if (options.prefixText) {
    note.appendChild(document.createTextNode(options.prefixText));
  }

  createExternalHelpLink(note, {
    text: options.linkText,
    href: options.href,
    className: options.linkClassName,
    ariaLabel: options.ariaLabel,
    datasetTestId: options.datasetTestId,
  });

  if (options.suffixText) {
    note.appendChild(document.createTextNode(options.suffixText));
  }

  container.appendChild(note);
  return note;
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
