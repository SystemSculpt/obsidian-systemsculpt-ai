import { App, setIcon } from "obsidian";

export type PopupResultAction = "primary" | "secondary" | "cancel";

interface PopupOptions {
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

export class PopupComponent {
  private checkboxEl?: HTMLInputElement;
  private app: App;
  private message: string;
  private options: PopupOptions;
  private containerEl: HTMLElement;
  private resolvePromise: (
    value: { confirmed: boolean; action?: PopupResultAction; inputs?: string[]; checkboxChecked?: boolean } | null
  ) => void;
  private result: { confirmed: boolean; action?: PopupResultAction; inputs?: string[]; checkboxChecked?: boolean } | null = null;
  private listeners: { element: HTMLElement; type: string; listener: EventListener }[] = [];

  constructor(app: App, message: string, options: PopupOptions = {}) {
    this.app = app;
    this.message = message;
    this.options = options;
  }

  private registerListener(element: HTMLElement, type: string, listener: EventListener) {
    element.addEventListener(type, listener);
    this.listeners.push({ element, type, listener });
  }

  private removeAllListeners() {
    this.listeners.forEach(({ element, type, listener }) => {
      element.removeEventListener(type, listener);
    });
    this.listeners = [];
  }

  private createPopup() {
    // Create container
    this.containerEl = document.createElement("div");
    this.containerEl.addClass("systemsculpt-popup-container");
    document.body.appendChild(this.containerEl);

    // Create popup
    const popupEl = this.containerEl.createDiv({ cls: "systemsculpt-popup" });
    const content = popupEl.createDiv({ cls: "systemsculpt-popup-content" });

    // Add title if provided
    if (this.options.title) {
      const titleEl = content.createDiv({ cls: "systemsculpt-popup-title" });
      if (this.options.icon) {
        const iconEl = titleEl.createSpan({ cls: "systemsculpt-popup-icon" });
        setIcon(iconEl, this.options.icon);
      }
      titleEl.createSpan({ text: this.options.title });
    }

    // Add main message
    if (this.message) {
      content.createDiv({
        cls: "systemsculpt-popup-message",
        text: this.message,
      });
    }

    // Add description if provided
    if (this.options.description) {
      content.createDiv({
        cls: "systemsculpt-popup-description",
        text: this.options.description,
      });
    }

    // Add checkbox if provided
    if (this.options.checkboxLabel) {
      const checkboxContainer = content.createDiv({ cls: "systemsculpt-popup-checkbox-container" });
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = "systemsculpt-popup-checkbox";
      const label = document.createElement("label");
      label.htmlFor = "systemsculpt-popup-checkbox";
      label.textContent = this.options.checkboxLabel;
      checkboxContainer.appendChild(checkbox);
      checkboxContainer.appendChild(label);
      this.checkboxEl = checkbox;
    }

    // Add inputs if provided
    if (this.options.inputs) {
      const inputsContainer = content.createDiv({
        cls: "systemsculpt-popup-inputs",
      });

      this.options.inputs.forEach((input) => {
        if (input.type === "textarea") {
          inputsContainer.createEl("textarea", {
            cls: `systemsculpt-popup-textarea ${input.className || ""}`,
            placeholder: input.placeholder,
            value: input.value || "",
            attr: {
              required: input.required ? true : null,
            },
          });
        } else {
          inputsContainer.createEl("input", {
            type: input.type,
            cls: `systemsculpt-popup-input ${input.className || ""}`,
            placeholder: input.placeholder,
            value: input.value || "",
            attr: {
              required: input.required ? true : null,
            },
          });
        }
      });
    }

    // Add buttons
    const buttonContainer = popupEl.createDiv({
      cls: "modal-button-container",
    });

    if (this.options.secondaryButton) {
      const secondaryButton = buttonContainer.createEl("button", {
        text: this.options.secondaryButton,
      });
      this.registerListener(secondaryButton, "click", () => {
        this.result = { confirmed: false, action: "secondary" };
        this.close();
      });
    }

    const primaryButton = buttonContainer.createEl("button", {
      text: this.options.primaryButton || "OK",
    });

    // Explicitly set button attribute to help with CSS targeting
    if (this.options.primaryButton) {
      primaryButton.setAttribute("data-button-text", this.options.primaryButton);
    }

    this.registerListener(primaryButton, "click", () => {
      if (this.options.inputs) {
        const inputs = Array.from(
          popupEl.querySelectorAll("input, textarea") as NodeListOf<
            HTMLInputElement | HTMLTextAreaElement
          >
        );

        // Check if any required inputs are empty
        const hasEmptyRequired = inputs.some(
          (input) => input.required && !input.value.trim()
        );
        if (hasEmptyRequired) {
          return;
        }

        this.result = {
          confirmed: true,
          action: "primary",
          inputs: inputs.map((input) => input.value),
          checkboxChecked: this.checkboxEl?.checked ?? false,
        };
      } else {
        this.result = {
          confirmed: true,
          action: "primary",
          checkboxChecked: this.checkboxEl?.checked ?? false,
        };
      }
      this.close();
    });

    // Add keyboard handlers
    this.registerListener(this.containerEl, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.result = { confirmed: false, action: "cancel" };
        this.close();
      }
      if (e.key === "Enter" && !e.isComposing && !e.shiftKey) {
        primaryButton.click();
      }
    });

    // Close on background click
    this.registerListener(this.containerEl, "mousedown", (e: MouseEvent) => {
      if (e.target === this.containerEl) {
        this.result = { confirmed: false, action: "cancel" };
        this.close();
      }
    });
  }

  private close() {
    this.containerEl.addClass("systemsculpt-popup-closing");
    setTimeout(() => {
      this.removeAllListeners();
      this.containerEl.remove();
      if (this.resolvePromise) {
        this.resolvePromise(this.result);
      }
    }, 200); // Match the animation duration
  }

  public open(): Promise<{ confirmed: boolean; action?: PopupResultAction; inputs?: string[]; checkboxChecked?: boolean } | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.createPopup();
    });
  }
}

export async function showPopup(
  app: App,
  message: string,
  options: PopupOptions = {}
): Promise<{ confirmed: boolean; action?: PopupResultAction; inputs?: string[]; checkboxChecked?: boolean } | null> {
  const popup = new PopupComponent(app, message, options);
  return popup.open();
}
