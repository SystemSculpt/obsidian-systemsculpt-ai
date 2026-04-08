import { setIcon } from "obsidian";

export interface PromptChipOptions {
  currentPromptName: string | null;
  onClick: () => void;
}

export function createPromptChip(parent: HTMLElement, options: PromptChipOptions): HTMLElement {
  const chip = parent.createDiv({ cls: "systemsculpt-prompt-chip" });

  const iconEl = chip.createSpan({ cls: "systemsculpt-prompt-chip-icon" });
  setIcon(iconEl, "scroll-text");

  const labelEl = chip.createSpan({
    cls: "systemsculpt-prompt-chip-label",
    text: options.currentPromptName || "No prompt",
  });

  if (!options.currentPromptName) {
    chip.classList.add("mod-empty");
  }

  chip.addEventListener("click", options.onClick);

  return chip;
}

export function updatePromptChip(chip: HTMLElement, promptName: string | null): void {
  const label = chip.querySelector(".systemsculpt-prompt-chip-label");
  if (label) {
    label.textContent = promptName || "No prompt";
  }
  chip.classList.toggle("mod-empty", !promptName);
}
