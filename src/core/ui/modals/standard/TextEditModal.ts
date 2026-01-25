import { App } from "obsidian";
import { StandardModal } from "./StandardModal";
import { DEFAULT_TITLE_GENERATION_PROMPT } from "src/types";


export interface TextEditOptions {
  title: string;
  description?: string;
  placeholder?: string;
  initialValue?: string;
  submitButtonText?: string;
  cancelButtonText?: string;
  withTitleGeneration?: boolean;
  titleGenerationCallback?: (text: string) => Promise<string>;
  size?: "small" | "medium" | "large" | "fullwidth";
  minHeight?: number;
  maxHeight?: number;
  allowEmpty?: boolean;
}

/**
 * TextEditModal is a standardized modal for editing text,
 * such as system prompts, templates, etc.
 */
export class TextEditModal extends StandardModal {
  private options: TextEditOptions;
  private textArea: HTMLTextAreaElement | null = null;
  private resolvePromise: ((text: string) => void) | null = null;
  private generateTitleButton: HTMLElement | null = null;
  private submitButton: HTMLElement | null = null;
  private titleGenerationLoading: boolean = false;

  constructor(app: App, options: TextEditOptions) {
    super(app);
    
    this.options = {
      submitButtonText: "Save",
      cancelButtonText: "Cancel",
      withTitleGeneration: false,
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
    
    // Add title generation button if enabled
    if (this.options.withTitleGeneration && this.options.titleGenerationCallback) {
      this.createTitleGenerationButton();
    }
    
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
    setTimeout(() => this.textArea?.focus(), 50);
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

    // Ensure vertical resize is enabled
    this.textArea.style.resize = "vertical";
    
    // Auto-resize functionality
    this.textArea.addEventListener("input", () => {
      this.autoResizeTextArea();
      this.updateSubmitButtonState();
    });
    
    // Initial resize
    setTimeout(() => this.autoResizeTextArea(), 0);
      // Create Reset to Default Prompt button
      const resetButton = textAreaContainer.createEl("button", { text: "Reset to Default Prompt" });
      resetButton.style.marginTop = "8px";
      resetButton.style.display = "block";
      resetButton.style.padding = "6px 12px";
      resetButton.style.fontSize = "0.9em";
      resetButton.style.cursor = "pointer";

      resetButton.addEventListener("click", () => {
          if (this.textArea) {
              this.textArea.value = DEFAULT_TITLE_GENERATION_PROMPT;
              // Trigger input event to update UI state
              this.textArea.dispatchEvent(new Event("input", { bubbles: true }));
          }
      });
  }

  /**
   * Create the title generation button
   */
  private createTitleGenerationButton() {
    const buttonContainer = this.contentEl.createDiv("ss-modal__title-generation");
    this.generateTitleButton = buttonContainer.createEl("button", {
      text: "Generate Title",
      cls: "ss-button ss-button--small"
    });
    
    this.generateTitleButton.addEventListener("click", this.handleTitleGeneration.bind(this));
  }

  /**
   * Handle title generation
   */
  private async handleTitleGeneration() {
    if (!this.options.titleGenerationCallback || !this.textArea || this.titleGenerationLoading) return;
    
    const text = this.textArea.value;
    if (!text) return;
    
    // Update button state
    this.titleGenerationLoading = true;
    if (this.generateTitleButton) {
      this.generateTitleButton.textContent = "Generating...";
      this.generateTitleButton.setAttribute("disabled", "true");
    }
    
    try {
      const generatedTitle = await this.options.titleGenerationCallback(text);
      this.textArea.value = generatedTitle;
      this.autoResizeTextArea();
      this.updateSubmitButtonState();
    } catch (error) {
    } finally {
      // Reset button state
      this.titleGenerationLoading = false;
      if (this.generateTitleButton) {
        this.generateTitleButton.textContent = "Generate Title";
        this.generateTitleButton.removeAttribute("disabled");
      }
    }
  }

  /**
   * Auto-resize the text area based on content
   */
  private autoResizeTextArea() {
    if (!this.textArea) return;
    
    // Reset height to auto to get the correct scrollHeight
    this.textArea.style.height = "auto";
    
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