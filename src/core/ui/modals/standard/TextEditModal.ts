import { App } from "obsidian";
import { StandardModal } from "./StandardModal";


export interface TextEditOptions {
  title: string;
  description?: string;
  placeholder?: string;
  initialValue?: string;
  submitButtonText?: string;
  cancelButtonText?: string;
  size?: "small" | "medium" | "large" | "fullwidth";
  minHeight?: number;
  maxHeight?: number;
  allowEmpty?: boolean;
}

/**
 * TextEditModal is a standardized modal for editing text,
 * such as system prompts, saved snippets, etc.
 */
export class TextEditModal extends StandardModal {
  private options: TextEditOptions;
  private textArea: HTMLTextAreaElement | null = null;
  private resolvePromise: ((text: string) => void) | null = null;
  private submitButton: HTMLElement | null = null;

  constructor(app: App, options: TextEditOptions) {
    super(app);
    
    this.options = {
      submitButtonText: "Save",
      cancelButtonText: "Cancel",
      size: "medium",
      minHeight: 100,
      maxHeight: 400,
      allowEmpty: false,
      ...options
    };
    
    // Set modal size
    if (this.options.size) {
      this.setSize(this.options.size);
    }
  }

  onOpen() {
    super.onOpen();
    
    // Add title and close button
    this.addTitle(this.options.title, this.options.description);
    
    // Create text area
    this.createTextArea();
    
    // Add footer buttons
    this.addActionButton(this.options.cancelButtonText || "Cancel", () => this.close(), false);
    this.submitButton = this.addActionButton(
      this.options.submitButtonText || "Save", 
      this.handleSubmit.bind(this), 
      true
    );
    
    // Initialize submit button state
    this.updateSubmitButtonState();
    
    // Focus text area
    window.setTimeout(() => this.textArea?.focus(), 50);
  }

  /**
   * Create the text area with auto-resize functionality
   */
  private createTextArea() {
    const textAreaContainer = this.contentEl.createDiv("ss-modal__textarea-container");
    
    this.textArea = textAreaContainer.createEl("textarea", {
      cls: "ss-modal__textarea",
      attr: {
        placeholder: this.options.placeholder || "Enter text...",
      }
    });
    
    // Set initial value if provided
    if (this.options.initialValue) {
      this.textArea.value = this.options.initialValue;
    }
    
    // Set initial height
    if (this.options.minHeight) {
      this.textArea.style.minHeight = `${this.options.minHeight}px`;
    }
    
    if (this.options.maxHeight) {
      this.textArea.style.maxHeight = `${this.options.maxHeight}px`;
    }

    // Vertical resize comes from .ss-modal__textarea (modals/modal.css)

    // Auto-resize functionality
    this.textArea.addEventListener("input", () => {
      this.autoResizeTextArea();
      this.updateSubmitButtonState();
    });
    
    // Initial resize
    window.setTimeout(() => this.autoResizeTextArea(), 0);
  }

  /**
   * Auto-resize the text area based on content
   */
  private autoResizeTextArea() {
    if (!this.textArea) return;
    
    // Reset height to auto to get the correct scrollHeight
    this.textArea.setCssStyles({ height: "auto" });
    
    // Set the height to the scrollHeight
    const newHeight = Math.min(
      Math.max(this.textArea.scrollHeight, this.options.minHeight || 100),
      this.options.maxHeight || 400
    );
    this.textArea.style.height = `${newHeight}px`;
  }

  /**
   * Update the submit button state based on text area content
   */
  private updateSubmitButtonState() {
    if (!this.submitButton || !this.textArea) return;
    
    const isEmpty = !this.textArea.value.trim();
    this.submitButton.toggleAttribute("disabled", !this.options.allowEmpty && isEmpty);
  }

  /**
   * Handle submit button click
   */
  private handleSubmit() {
    if (!this.textArea) return;
    
    const text = this.textArea.value;
    
    // Check if empty is allowed
    if (!this.options.allowEmpty && !text.trim()) {
      return;
    }
    
    // Resolve the promise with the text
    if (this.resolvePromise) {
      this.resolvePromise(text);
      this.close();
    }
  }

  /**
   * Get the current value of the text area
   */
  getValue(): string {
    return this.textArea?.value || "";
  }

  /**
   * Open the modal and return a promise that resolves with the edited text
   */
  openAndGetText(): Promise<string> {
    return new Promise(resolve => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onClose() {
    // Remove event listeners
    if (this.textArea) {
      this.textArea.removeEventListener("input", this.autoResizeTextArea);
    }
    
    // Clean up
    super.onClose();
  }
}
