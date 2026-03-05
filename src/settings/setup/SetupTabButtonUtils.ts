import { ButtonComponent } from "obsidian";

export type ButtonVariant = "primary" | "secondary";

export function styleSettingButton(
  button: ButtonComponent,
  variant: ButtonVariant,
  label: string
): void {
  const buttonEl = button.buttonEl;
  buttonEl.classList.remove("mod-cta");
  buttonEl.classList.remove("mod-cta-outline");
  buttonEl.classList.remove("mod-warning");
  buttonEl.classList.remove("ss-button--primary");
  buttonEl.classList.remove("ss-button--secondary");
  buttonEl.classList.add("ss-button");
  buttonEl.classList.add(variant === "primary" ? "ss-button--primary" : "ss-button--secondary");
  buttonEl.dataset.ssIdleLabel = label;
  button.setButtonText(label);
}

export interface ButtonLoadingOptions {
  idleText?: string;
  loadingText: string;
}

export async function withButtonLoadingState<T>(
  button: ButtonComponent,
  options: ButtonLoadingOptions,
  action: () => Promise<T>
): Promise<T> {
  const buttonEl = button.buttonEl;

  if (!buttonEl.dataset.ssIdleLabel) {
    buttonEl.dataset.ssIdleLabel = buttonEl.textContent?.trim() || "";
  }

  const idleText = options.idleText ?? buttonEl.dataset.ssIdleLabel ?? "";

  if (!buttonEl.classList.contains("ss-button")) {
    styleSettingButton(button, "primary", idleText || buttonEl.textContent?.trim() || "");
  }

  const previousMinWidth = buttonEl.style.minWidth;
  if (!previousMinWidth) {
    const width = buttonEl.getBoundingClientRect().width;
    if (width > 0) {
      buttonEl.style.minWidth = `${width}px`;
    }
  }

  button.setDisabled(true);
  button.setButtonText(options.loadingText);
  buttonEl.classList.add("ss-loading");

  try {
    return await action();
  } finally {
    buttonEl.classList.remove("ss-loading");
    button.setDisabled(false);
    button.setButtonText(buttonEl.dataset.ssIdleLabel || idleText);
    if (previousMinWidth) {
      buttonEl.style.minWidth = previousMinWidth;
    } else {
      buttonEl.style.removeProperty("min-width");
    }
  }
}
