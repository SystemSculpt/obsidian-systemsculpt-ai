import { App, MarkdownView, Notice, setIcon } from "obsidian";
import SystemSculptPlugin from "../main";
import { ChatMessage, ChatRole } from "../types";
import { ImproveResponseModal } from "./ImproveResponseModal";

import { attachFolderSuggester } from "../components/FolderSuggester";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { SaveAsNoteModal } from "./SaveAsNoteModal";

export interface AIResponseModalOptions {
  plugin: SystemSculptPlugin;
  modelId: string;
  messages: ChatMessage[];
  onInsert?: (response: string) => void;
  commandText?: string; // The command text to filter out from the note content
  parentModal?: StandardModal; // Reference to the parent modal (StandardTemplateModal) to close it
}

/**
 * StandardAIResponseModal is a standardized modal for displaying AI responses
 * with options to copy, insert, regenerate, save as note, etc.
 */
export class StandardAIResponseModal extends StandardModal {
  private responseContainer: HTMLElement;
  private buttonContainer: HTMLElement;
  private loadingEl?: HTMLElement;
  private fullResponse: string = "";
  private plugin: SystemSculptPlugin;
  private modelId: string;
  private messages: ChatMessage[];
  private onInsert: (response: string) => void;
  private isGenerating: boolean = false;
  private commandText?: string;
  private parentModal?: StandardModal; // Reference to the parent modal

  constructor(app: App, options: AIResponseModalOptions) {
    super(app);

    // Add standardized modal classes and set size
    this.setSize("large");

    this.plugin = options.plugin;
    this.modelId = options.modelId;
    this.messages = options.messages;
    this.onInsert = options.onInsert || (() => {});
    this.commandText = options.commandText;
    this.parentModal = options.parentModal;
  }

  onOpen() {
    super.onOpen();

    // Add title and close button
    this.addTitle("AI Response");

    // Create response container
    this.responseContainer = this.contentEl.createDiv("ss-modal__response-container");
    this.responseContainer.style.padding = "20px";
    this.responseContainer.style.backgroundColor = "var(--background-secondary)";
    this.responseContainer.style.borderRadius = "8px";
    this.responseContainer.style.whiteSpace = "pre-wrap";
    this.responseContainer.style.maxHeight = "60vh";
    this.responseContainer.style.minHeight = "250px";
    this.responseContainer.style.overflow = "auto";
    this.responseContainer.style.marginBottom = "20px";
    this.responseContainer.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.1)";
    this.responseContainer.style.display = "flex";
    this.responseContainer.style.flexDirection = "column";
    this.responseContainer.style.justifyContent = "center";
    this.responseContainer.style.fontSize = "15px";
    this.responseContainer.style.lineHeight = "1.5";

    // Create button container in the footer
    this.buttonContainer = this.footerEl.createDiv("ss-button-container");
    this.buttonContainer.style.display = "flex";
    this.buttonContainer.style.flexWrap = "wrap";
    this.buttonContainer.style.gap = "10px";
    this.buttonContainer.style.justifyContent = "center";
    this.buttonContainer.style.alignItems = "center";
    this.buttonContainer.style.marginTop = "12px";

    // Inject redesign styles if not already present
    if (!document.getElementById("ss-airesponse-redesign-styles")) {
      const styleEl = document.createElement("style");
      styleEl.id = "ss-airesponse-redesign-styles";
      styleEl.textContent = `
        .ss-button {
          min-width: 120px;
          max-width: 200px;
          flex: 1 1 auto;
        }
      `;
      document.head.appendChild(styleEl);
    }

    // Start generating the response
    this.generateResponse();
  }

  private createLoadingIndicator() {
    // Remove existing loading indicator if any
    if (this.loadingEl) {
      this.loadingEl.remove();
    }

    // Create a loading indicator that takes up the full container
    this.loadingEl = this.responseContainer.createDiv("ss-modal__loading");
    this.loadingEl.style.display = "flex";
    this.loadingEl.style.alignItems = "center";
    this.loadingEl.style.justifyContent = "center";
    this.loadingEl.style.height = "100%";
    this.loadingEl.style.width = "100%";
    this.loadingEl.style.minHeight = "200px";
    this.loadingEl.style.boxSizing = "border-box";

    // Add loading text with a clean, minimal style
    const loadingTextEl = this.loadingEl.createDiv("ss-modal__loading-text");
    loadingTextEl.setText("Processing with AI...");
    loadingTextEl.style.fontWeight = "600";
    loadingTextEl.style.color = "var(--text-accent)";
    loadingTextEl.style.fontSize = "20px";
    loadingTextEl.style.letterSpacing = "0.5px";
    loadingTextEl.style.textAlign = "center";

    // Add a smooth pulse animation to the text
    if (!document.getElementById("systemsculpt-pulse-keyframes")) {
      const styleEl = document.createElement("style");
      styleEl.id = "systemsculpt-pulse-keyframes";
      styleEl.textContent = `
        @keyframes pulse {
          0% { opacity: 0.4; }
          50% { opacity: 1; }
          100% { opacity: 0.4; }
        }
        .ss-modal__loading-text {
          animation: pulse 2.5s infinite ease-in-out;
        }
      `;
      document.head.appendChild(styleEl);
    }
  }

  private async generateResponse() {
    if (this.isGenerating) return;
    this.isGenerating = true;

    try {
      // Clear previous response
      this.responseContainer.empty();
      this.buttonContainer.empty();
      this.fullResponse = "";

      // Show loading indicator
      this.createLoadingIndicator();

      // Stream the response from the LLM
      try {
        // Use the aiService to stream the response
        const streamGenerator = this.plugin.aiService.streamMessage({
          messages: this.messages,
          model: this.modelId,
        });

        // Process the stream
        for await (const event of streamGenerator) {
          if (event.type === "content") {
            // Remove loading indicator on first chunk
            if (this.loadingEl && this.fullResponse === "") {
              this.loadingEl.remove();
              this.loadingEl = undefined;

              // Reset container style for text content
              this.responseContainer.style.display = "block";
              this.responseContainer.style.justifyContent = "initial";
            }

            this.fullResponse += event.text;
            this.responseContainer.setText(this.fullResponse);
            // Auto-scroll to bottom
            this.responseContainer.scrollTop = this.responseContainer.scrollHeight;
          }
        }

        // Create buttons after response is complete
        this.createButtons();

      } catch (error) {
        // Show error in the response container
        if (this.loadingEl) {
          this.loadingEl.remove();

          // Reset container style for text content
          this.responseContainer.style.display = "block";
          this.responseContainer.style.justifyContent = "initial";
        }
        this.responseContainer.setText(`Error: ${error.message || "Failed to get response from AI"}`);

        // Still create buttons so user can close or retry
        this.createButtons();
      }
    } catch (error) {
      new Notice("Failed to process with AI. Please try again.");
    } finally {
      this.isGenerating = false;
    }
  }

  // Helper method to close all modals and clean up command text
  private closeAllModals() {
    // Remove command text from editor if it exists
    if (this.commandText) {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView) {
        const editor = activeView.editor;
        const content = editor.getValue();
        const commandIndex = content.indexOf(this.commandText);

        if (commandIndex >= 0) {
          // Calculate the start and end positions
          const startPos = editor.offsetToPos(commandIndex);
          const endPos = editor.offsetToPos(commandIndex + this.commandText.length);

          // Remove the command text
          editor.replaceRange("", startPos, endPos);
        }
      }
    }

    // Close this modal
    this.close();

    // Close parent modal if it exists
    if (this.parentModal) {
      this.parentModal.close();
    }

    // Focus the active editor if available
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      activeView.editor.focus();
    }
  }

  private createButtons() {
    // Clear existing buttons
    this.buttonContainer.empty();

    // Helper function to create a button with an icon
    const createButtonWithIcon = (text: string, iconName: string, buttonClass: string = "ss-button") => {
      const button = this.buttonContainer.createEl("button", { cls: buttonClass });
      const icon = button.createSpan("ss-button__icon");
      setIcon(icon, iconName);
      button.appendChild(document.createTextNode(text));
      return button;
    };

    // Regenerate button
    const regenerateButton = createButtonWithIcon("Regenerate", "refresh-ccw", "ss-button mod-warning");
    this.registerDomEvent(regenerateButton, "click", () => this.generateResponse());

    // Copy button
    const copyButton = createButtonWithIcon("Copy", "copy");
    this.registerDomEvent(copyButton, "click", async () => {
      await navigator.clipboard.writeText(this.fullResponse);
      new Notice("Response copied to clipboard");

      // Show visual feedback
      copyButton.textContent = "Copied!";
      setTimeout(() => {
        copyButton.innerHTML = "";
        const text = document.createTextNode("Copy");
        copyButton.appendChild(text);
        const newIcon = copyButton.createSpan("ss-button__icon");
        setIcon(newIcon, "copy");
      }, 2000);
    });

    // Insert button
    const insertButton = createButtonWithIcon("Insert", "text-cursor-input", "ss-button ss-button--primary");
    insertButton.addClass("mod-cta");
    this.registerDomEvent(insertButton, "click", () => {
      this.onInsert(this.fullResponse);
      this.closeAllModals();
    });

    // Save as Note button
    const saveAsNoteButton = createButtonWithIcon("Save as Note", "file-plus");
    this.registerDomEvent(saveAsNoteButton, "click", () => {
      const now = new Date();
      const defaultFileName = `AI Response ${now.toLocaleDateString()} ${now.toLocaleTimeString().replace(/:/g, ".")}`;
      const modal = new SaveAsNoteModal(
        this.app,
        this.plugin,
        this.plugin.settings.lastSaveAsNoteFolder || "SystemSculpt/AI Responses",
        defaultFileName,
        this.fullResponse,
        () => this.closeAllModals()
      );
      modal.open();
    });

    // Improve button
    const improveButton = createButtonWithIcon("Improve", "sparkles");
    this.registerDomEvent(improveButton, "click", () => {
      const promptText = "Choose how to improve the response:";

      const improveModal = new ImproveResponseModal(
        this.app,
        promptText,
        "shorter",
        (inputValue: string) => {
          const improvementPrompt = "The user has requested that this text should be improved upon, and they provided these improvement details / requirements: " + inputValue;

          const assistantMsg: ChatMessage = {
            role: "assistant" as ChatRole,
            content: this.fullResponse,
            message_id: `assistant_${Date.now()}`
          };

          const userMsg: ChatMessage = {
            role: "user" as ChatRole,
            content: improvementPrompt,
            message_id: `user_${Date.now()}`
          };

          const modal = new StandardAIResponseModal(this.app, {
            plugin: this.plugin,
            modelId: this.modelId,
            messages: [...this.messages, assistantMsg, userMsg],
            onInsert: this.onInsert,
            commandText: this.commandText,
            parentModal: this.parentModal
          });

          this.close();
          modal.open();
        }
      );

      improveModal.open();
    });

    // Close button
    const closeButton = createButtonWithIcon("Close", "x");
    this.registerDomEvent(closeButton, "click", () => this.closeAllModals());
  }

}

export async function showAIResponseModal(
  app: App,
  options: AIResponseModalOptions
): Promise<void> {
  const modal = new StandardAIResponseModal(app, options);
  modal.open();
}
