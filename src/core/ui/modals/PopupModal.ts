import { App, setIcon } from "obsidian";
import { StandardModal } from "./standard/StandardModal";

export type PopupResultAction = "primary" | "secondary" | "cancel";

export interface PopupOptions {
  primaryButton?: string;
  secondaryButton?: string;
  title?: string;
  description?: string;
  icon?: string;
  checkboxLabel?: string;
  inputs?: {
    type: string;
    placeholder?: string;
    required?: boolean;
    className?: string;
    value?: string;
  }[];
}

export interface PopupResult {
  confirmed: boolean;
  action?: PopupResultAction;
  inputs?: string[];
  checkboxChecked?: boolean;
}

let popupTitleId = 0;

/**
 * Compact confirmation/input modal on the shared StandardModal shell.
 * The public promise API stays stable for existing callers.
 */
export class PopupComponent extends StandardModal {
  private readonly message: string;
  private readonly options: PopupOptions;
  private readonly titleId = `ss-popup-title-${++popupTitleId}`;
  private readonly descriptionId = `${this.titleId}-description`;

  private checkboxEl?: HTMLInputElement;
  private fieldEls: Array<HTMLInputElement | HTMLTextAreaElement> = [];
  private primaryButton?: HTMLButtonElement;
  private resolvePromise: (value: PopupResult | null) => void = () => undefined;
  private result: PopupResult | null = null;
  private settled = false;

  constructor(app: App, message: string, options: PopupOptions = {}) {
    super(app);
    this.message = message;
    this.options = options;
    this.setSize("small");
    this.modalEl.addClass("ss-popup-modal");
  }

  open(): Promise<PopupResult | null> {
    this.result = null;
    this.settled = false;
    this.checkboxEl = undefined;
    this.fieldEls = [];
    this.primaryButton = undefined;

    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      super.open();
    });
  }

  onOpen(): void {
    super.onOpen();
    this.modalEl.setAttr("tabindex", "-1");

    const title = this.resolveHeaderTitle();
    const description = this.resolveHeaderDescription();
    const bodyMessage = this.resolveBodyMessage();

    this.renderHeader(title, description);

    const body = this.contentEl.createDiv({
      cls: "ss-modal__custom-content ss-popup-modal__body",
    });

    if (bodyMessage) {
      body.createEl("p", {
        cls: "ss-popup-modal__message",
        text: bodyMessage,
      });
    }

    if (this.options.inputs?.length) {
      this.renderInputs(body);
    }

    if (this.options.checkboxLabel) {
      this.renderCheckbox(body);
    }

    if (this.options.secondaryButton) {
      this.addActionButton(this.options.secondaryButton, () => {
        this.result = { confirmed: false, action: "secondary" };
        this.close();
      });
    }

    this.primaryButton = this.addActionButton(
      this.options.primaryButton || "OK",
      () => this.submit(),
      true
    );
    this.primaryButton.setAttr("type", "button");

    this.registerDomEvent(this.modalEl, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.cancel();
        return;
      }

      if (event.key !== "Enter" || event.isComposing) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const isInput = target instanceof HTMLInputElement;
      const isTextarea = target instanceof HTMLTextAreaElement;
      if (!isInput && !isTextarea && target !== this.modalEl) {
        return;
      }

      if (isTextarea && !event.metaKey && !event.ctrlKey) {
        return;
      }

      if (!isTextarea && event.shiftKey) {
        return;
      }

      event.preventDefault();
      this.submit();
    });

    this.syncValidationState(false);

    const initialFocus = this.fieldEls[0] ?? this.primaryButton ?? this.modalEl;
    initialFocus.focus();
  }

  onClose(): void {
    super.onClose();
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolvePromise(this.result);
  }

  private resolveHeaderTitle(): string {
    if (this.options.title?.trim()) {
      return this.options.title.trim();
    }
    if (this.options.description?.trim()) {
      return this.message;
    }
    return "Notice";
  }

  private resolveHeaderDescription(): string | undefined {
    const description = this.options.description?.trim();
    return description ? description : undefined;
  }

  private resolveBodyMessage(): string | undefined {
    const message = this.message.trim();
    if (!message) {
      return undefined;
    }
    if (!this.options.title?.trim() && this.options.description?.trim()) {
      return undefined;
    }
    return message;
  }

  private renderHeader(title: string, description?: string): void {
    const titleContainer = this.headerEl.createDiv({ cls: "ss-modal__title-container" });
    const lead = titleContainer.createDiv({ cls: "ss-popup-modal__title-lead" });

    if (this.options.icon) {
      const iconEl = lead.createSpan({ cls: "ss-popup-modal__title-icon" });
      setIcon(iconEl, this.options.icon);
    }

    lead.createEl("h2", {
      text: title,
      cls: "ss-modal__title",
      attr: { id: this.titleId },
    });

    const closeButton = titleContainer.createEl("button", {
      cls: "ss-modal__close-button",
      attr: {
        type: "button",
        "aria-label": "Close",
      },
    });
    setIcon(closeButton, "x");
    this.registerDomEvent(closeButton, "click", () => this.cancel());

    this.modalEl.setAttr("role", "dialog");
    this.modalEl.setAttr("aria-modal", "true");
    this.modalEl.setAttr("aria-labelledby", this.titleId);

    if (description) {
      this.headerEl.createDiv({
        text: description,
        cls: "ss-modal__description",
        attr: { id: this.descriptionId },
      });
      this.modalEl.setAttr("aria-describedby", this.descriptionId);
    } else {
      this.modalEl.removeAttribute("aria-describedby");
    }
  }

  private renderInputs(container: HTMLElement): void {
    const inputsContainer = container.createDiv({ cls: "ss-popup-modal__inputs" });

    this.options.inputs?.forEach((definition, index) => {
      const isTextarea = definition.type === "textarea";
      const field = isTextarea
        ? inputsContainer.createEl("textarea", {
            cls: "ss-popup-modal__field ss-popup-modal__field--textarea",
          })
        : inputsContainer.createEl("input", {
            cls: "ss-popup-modal__field",
            attr: { type: definition.type || "text" },
          });

      if (!isTextarea && field instanceof HTMLInputElement) {
        field.type = definition.type || "text";
      }

      field.placeholder = definition.placeholder || "";
      field.value = definition.value || "";
      field.required = Boolean(definition.required);
      field.setAttr("aria-label", definition.placeholder || `Input ${index + 1}`);
      field.toggleClass("is-required", Boolean(definition.required));

      if (definition.className) {
        definition.className
          .split(/\s+/)
          .filter(Boolean)
          .forEach((className) => field.addClass(className));
      }

      this.fieldEls.push(field);

      this.registerDomEvent(field, "input", () => this.syncValidationState(false));
      this.registerDomEvent(field, "blur", () => this.syncValidationState(true));
    });
  }

  private renderCheckbox(container: HTMLElement): void {
    const checkboxRow = container.createEl("label", {
      cls: "ss-popup-modal__checkbox",
    });
    this.checkboxEl = checkboxRow.createEl("input", {
      attr: {
        type: "checkbox",
      },
    });
    checkboxRow.createSpan({ text: this.options.checkboxLabel });
  }

  private submit(): void {
    if (!this.syncValidationState(true)) {
      return;
    }

    this.result = {
      confirmed: true,
      action: "primary",
      inputs: this.fieldEls.length ? this.fieldEls.map((field) => field.value) : undefined,
      checkboxChecked: this.checkboxEl?.checked ?? false,
    };
    this.close();
  }

  private cancel(): void {
    this.result = { confirmed: false, action: "cancel" };
    this.close();
  }

  private syncValidationState(showErrors: boolean): boolean {
    const invalidField = this.fieldEls.find((field) => field.required && !field.value.trim());

    this.fieldEls.forEach((field) => {
      const invalid = field.required && !field.value.trim();
      field.setAttr("aria-invalid", invalid ? "true" : "false");
      field.toggleClass("is-invalid", showErrors && invalid);
    });

    if (this.primaryButton) {
      this.primaryButton.disabled = Boolean(invalidField);
    }

    if (showErrors && invalidField) {
      invalidField.focus();
    }

    return !invalidField;
  }
}

export async function showPopup(
  app: App,
  message: string,
  options: PopupOptions = {}
): Promise<PopupResult | null> {
  const popup = new PopupComponent(app, message, options);
  return popup.open();
}
