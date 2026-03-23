import { App, Modal } from "obsidian";

type StudioAiImageEditPromptModalOptions = {
  app: App;
  title?: string;
  description?: string;
  initialPrompt?: string;
};

class StudioAiImageEditPromptModal extends Modal {
  private readonly modalTitle: string;
  private readonly description: string;
  private readonly initialPrompt: string;
  private resolvePromise: ((value: string | null) => void) | null = null;
  private settled = false;
  private textareaEl!: HTMLTextAreaElement;
  private submitButtonEl!: HTMLButtonElement;

  constructor(options: StudioAiImageEditPromptModalOptions) {
    super(options.app);
    this.modalTitle = String(options.title || "Edit with AI").trim() || "Edit with AI";
    this.description =
      String(options.description || "").trim() ||
      "Describe how you want the AI to change this image.";
    this.initialPrompt = String(options.initialPrompt || "");
  }

  onOpen(): void {
    if (typeof (this as unknown as { setTitle?: (value: string) => void }).setTitle === "function") {
      (this as unknown as { setTitle: (value: string) => void }).setTitle(this.modalTitle);
    } else {
      this.titleEl.setText(this.modalTitle);
    }

    this.modalEl.addClass("ss-studio-ai-image-edit-modal-shell");

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ss-studio-ai-image-edit-modal");

    const introEl = contentEl.createDiv({ cls: "ss-studio-ai-image-edit-modal-intro" });
    introEl.createEl("p", {
      cls: "ss-studio-ai-image-edit-modal-copy",
      text: this.description,
    });
    introEl.createEl("p", {
      cls: "ss-studio-ai-image-edit-modal-subcopy",
      text: "Studio will keep the original image, add a new AI edit step, and append the edited result.",
    });

    const fieldEl = contentEl.createDiv({ cls: "ss-studio-ai-image-edit-modal-field" });
    const promptId = `ss-studio-ai-image-edit-prompt-${Date.now().toString(36)}`;
    fieldEl.createEl("label", {
      cls: "ss-studio-ai-image-edit-modal-label",
      text: "Edit prompt",
      attr: {
        for: promptId,
      },
    });

    this.textareaEl = fieldEl.createEl("textarea", {
      cls: "ss-studio-ai-image-edit-modal-textarea",
      attr: {
        id: promptId,
        placeholder: "Describe the changes you want...",
        "aria-label": "AI image edit prompt",
        spellcheck: "true",
      },
    });
    this.textareaEl.value = this.initialPrompt;
    this.textareaEl.rows = 8;

    fieldEl.createEl("p", {
      cls: "ss-studio-ai-image-edit-modal-helper",
      text: "Tip: mention what should stay the same, what should change, and the style you want.",
    });

    const actionsEl = contentEl.createDiv({ cls: "ss-studio-ai-image-edit-modal-actions" });
    actionsEl.createEl("div", {
      cls: "ss-studio-ai-image-edit-modal-shortcut",
      text: "⌘/Ctrl + Enter to submit",
    });

    const actionButtonsEl = actionsEl.createDiv({ cls: "ss-studio-ai-image-edit-modal-action-buttons" });
    const cancelButtonEl = actionButtonsEl.createEl("button", {
      text: "Cancel",
      cls: "mod-muted",
    });
    cancelButtonEl.type = "button";
    cancelButtonEl.addEventListener("click", () => {
      this.close();
    });

    this.submitButtonEl = actionButtonsEl.createEl("button", {
      text: "Edit with AI",
      cls: "mod-cta",
    });
    this.submitButtonEl.type = "button";
    this.submitButtonEl.addEventListener("click", () => {
      this.submit();
    });

    this.textareaEl.addEventListener("input", () => {
      this.syncSubmitButtonState();
    });
    this.textareaEl.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
    });

    this.syncSubmitButtonState();

    window.setTimeout(() => {
      this.textareaEl.focus();
      const end = this.textareaEl.value.length;
      this.textareaEl.setSelectionRange(end, end);
    }, 0);
  }

  onClose(): void {
    this.modalEl.removeClass("ss-studio-ai-image-edit-modal-shell");
    this.contentEl.removeClass("ss-studio-ai-image-edit-modal");
    if (!this.settled && this.resolvePromise) {
      this.resolvePromise(null);
    }
    this.resolvePromise = null;
    this.contentEl.empty();
  }

  async openAndGetValue(): Promise<string | null> {
    return await new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  private syncSubmitButtonState(): void {
    if (!this.submitButtonEl) {
      return;
    }
    const hasPrompt = String(this.textareaEl?.value || "").trim().length > 0;
    this.submitButtonEl.disabled = !hasPrompt;
  }

  private submit(): void {
    const value = String(this.textareaEl?.value || "").trim();
    if (!value) {
      this.textareaEl?.focus();
      this.syncSubmitButtonState();
      return;
    }
    this.settled = true;
    this.resolvePromise?.(value);
    this.resolvePromise = null;
    this.close();
  }
}

export async function openStudioAiImageEditPromptModal(
  options: StudioAiImageEditPromptModalOptions
): Promise<string | null> {
  const modal = new StudioAiImageEditPromptModal(options);
  return await modal.openAndGetValue();
}
