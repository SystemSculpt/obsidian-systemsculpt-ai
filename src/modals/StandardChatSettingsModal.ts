import { App, ButtonComponent, Setting, SuggestModal, Notice } from "obsidian";
import { ChatMessage } from "../types";
import { SystemPromptService, normalizeDesktopPromptSelectionType } from "../services/SystemPromptService";
import { StandardModelSelectionModal, ModelSelectionResult } from "./StandardModelSelectionModal";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { TitleGenerationService } from "../services/TitleGenerationService";
import SystemSculptPlugin from "../main";
import { getDisplayName, ensureCanonicalId, getModelLabelWithProvider } from "../utils/modelUtils";
import { ChatView } from "../views/chatview/ChatView";
import { GENERAL_USE_PRESET, CONCISE_PRESET } from "../constants/prompts";

export interface ChatSystemPromptModalOptions {
  plugin: SystemSculptPlugin; // Required for model list, title generation, etc.
  chatView?: ChatView;      // Optional, only for full chat context
  currentPrompt?: string;
  currentSystemPromptType?: "general-use" | "concise" | "agent" | "custom";
  systemPromptPath?: string;
  chatTitle?: string;
  currentModelId?: string;
  messages?: ChatMessage[]; // For title generation context
  onTitleChange?: (newTitle: string) => Promise<void>;
  onModelSelect?: (modelId: string) => Promise<void>;
  mode?: "full" | "defaults-only"; // New: controls which UI to show
  chatFontSize?: "small" | "medium" | "large";
}

export interface ChatSystemPromptResult {
  type: "general-use" | "concise" | "agent" | "custom";
  prompt: string;
  path?: string;
  modelId?: string;
  title?: string;
}

// Adjust suggest modal to work with { path: string, name: string } type
class CustomPromptFileSuggestModal extends SuggestModal<{ path: string; name: string }> {
  private systemPromptService: SystemPromptService;
  private onSelectCallback: (file: { path: string; name: string }) => void;

  constructor(app: App, systemPromptService: SystemPromptService, onSelect: (file: { path: string; name: string }) => void) {
    super(app);
    this.systemPromptService = systemPromptService;
    this.onSelectCallback = onSelect;
    this.setPlaceholder("Select a custom system prompt file...");
  }

  async getSuggestions(query: string): Promise<{ path: string; name: string }[]> {
    // Use the correct method name
    const files = await this.systemPromptService.getCustomPromptFiles();
    if (!query) {
      return files;
    }
    // Filter based on the name property
    return files.filter((file: any) => file.name.toLowerCase().includes(query.toLowerCase()));
  }

  renderSuggestion(file: { path: string; name: string }, el: HTMLElement) {
    el.createEl("div", { text: file.name });
    el.createEl("small", { text: file.path, cls: "ss-suggestion-path" });
  }

  onChooseSuggestion(file: { path: string; name: string }, evt: MouseEvent | KeyboardEvent) {
    this.onSelectCallback(file);
  }
}

/**
 * A modal for managing chat settings: Title, AI Model, and System Prompt.
 * Uses a two-panel layout.
 */
export class StandardChatSettingsModal extends StandardModal {
  private options: ChatSystemPromptModalOptions;
  private result: ChatSystemPromptResult | null = null;
  private systemPromptService: SystemPromptService;
  private titleGenerationService: TitleGenerationService;

  // UI Elements
  private titleInput: HTMLInputElement;
  private generateTitleButton: HTMLButtonElement;
  private modelNameDisplay: HTMLElement;
  private changeModelButton: HTMLButtonElement;
  private presetButtons: Record<string, ButtonComponent> = {};
  private changeFileButton: ButtonComponent;
  private changeDefaultButton: ButtonComponent;
  private selectedFileInfo: HTMLElement;
  private promptTextEditor: HTMLTextAreaElement;

  // State
  private currentPrompt: string;
  private currentType: "general-use" | "concise" | "agent" | "custom";
  private currentPath?: string;
  private currentTitle: string;
  private currentModelId: string;
  private currentChatFontSize: "small" | "medium" | "large";
  private isGeneratingTitle: boolean = false;
  private settingsChangedListener: (() => void) | null = null;

  constructor(app: App, options: ChatSystemPromptModalOptions) {
    super(app);
    this.options = options;
    this.systemPromptService = SystemPromptService.getInstance(this.app, () => this.options.plugin.settings);
    this.titleGenerationService = TitleGenerationService.getInstance(this.options.plugin);

    // Initialize state from options
    this.currentPrompt = options.currentPrompt ?? "";
    this.currentType = normalizeDesktopPromptSelectionType(options.currentSystemPromptType);
    this.currentPath = options.systemPromptPath;
    this.currentTitle = options.chatTitle ?? "";
    this.currentModelId = options.currentModelId ?? "";
    this.currentChatFontSize = options.chatView?.chatFontSize || options.plugin.settings.chatFontSize || "medium";

    // --- Apply New CSS Class ---
    this.modalEl.addClass("ss-chat-settings-modal");

    this.setSize("large"); // Keep size large for two panels
    // REMOVED: this.containerEl.addClasses(["ss-system-prompt-modal", "ss-chat-modal-layout"]);
  }

  onOpen() {
    super.onOpen(); // Call parent onOpen if it exists
    
    // Add title and close button using the StandardModal method
    const title = this.options.mode === "defaults-only" 
      ? "Default Chat Presets" 
      : "Chat Settings";
    this.addTitle(title);
    
    this.display();
    this.updatePresetButtons();
    this.updateSelectedFileInfo();
    this.updateModelDisplay();
    this.loadInitialPrompt(); // Load prompt into editor after elements exist

    // Add event listener for settings changes
    if (this.options.plugin && this.options.plugin.emitter) {
      this.settingsChangedListener = () => {
        this.updateSelectedFileInfo();
        this.updatePresetButtons();
      };
      this.options.plugin.emitter.on('settingsChanged', this.settingsChangedListener);
    }
  }

  private display() {
    const { contentEl } = this;
    contentEl.empty(); // Clear existing content

    if (this.options.mode === "defaults-only") {
      // Section: Modal Title
      contentEl.createEl("h3", { text: "Default Chat Presets" });

      // Introductory label
      const intro = contentEl.createDiv();
      intro.createEl("div", {
        text: "Set your default AI model and system prompt type for new chats. These presets will be used every time you start a new, fresh chat."
      });

      // Divider after intro
      contentEl.createEl("hr");

      // Section: AI Model
      contentEl.createEl("h3", { text: "AI Model" });
      const modelSetting = new Setting(contentEl)
        .addButton((btn) => {
          btn.setButtonText("Change Model")
            .onClick(this.openModelSelectModal);
        });
      // Show the current model in a read-only input
      const modelInput = modelSetting.controlEl.createEl("input", {
        type: "text",
        value: this.currentModelId
          ? getDisplayName(this.currentModelId)
          : (this.options.plugin?.settings?.selectedModelId
            ? getDisplayName(this.options.plugin.settings.selectedModelId)
            : "No model selected"),
        attr: { readonly: "true" }
      });
      modelInput.style.marginRight = "8px";
      this.modelNameDisplay = modelInput;

      // Divider after model setting
      contentEl.createEl("hr");

      // Section: System Prompt Type
      contentEl.createEl("h3", { text: "System Prompt Type" });
      const promptSetting = new Setting(contentEl);
      // Add the preset buttons to the promptSetting controlEl
      const buttonContainer = promptSetting.controlEl.createDiv();
      this.createPresetButtons(buttonContainer);
      this.selectedFileInfo = promptSetting.controlEl.createDiv();
      this.updateSelectedFileInfo();
      this.updatePresetButtons();

      // Divider at the bottom for padding
      contentEl.createEl("hr");
    } else {
      // Create layout panels using NEW classes
      const leftPanel = contentEl.createDiv("ss-chat-settings-modal__left-panel");
      const rightPanel = contentEl.createDiv("ss-chat-settings-modal__right-panel");
      // Full chat settings mode
      this.createTitleSection(leftPanel);
      this.createModelSection(leftPanel);
      this.createChatFontSizeSection(leftPanel);
      this.createSystemPromptTypeSection(leftPanel, false);
      this.createPromptEditorSection(rightPanel);

      // Add default settings at the very end, after the prompt editor section
      this.createDefaultSettingsSection(rightPanel);
    }
  }

  // --- Section Creation Methods (Using NEW Classes) ---

  private createTitleSection(containerEl: HTMLElement) {
    const section = containerEl.createDiv("ss-chat-settings-modal__section");
    section.createEl("h3", { text: "Chat Title", cls: "ss-chat-settings-modal__section-title" });

    // Create the controls using the same approach as the model section
    const controls = section.createDiv("ss-chat-settings-modal__model-controls");
    controls.style.display = "flex";
    controls.style.gap = "5px";
    controls.style.width = "100%";

    // Read-only input for title (matching model input style)
    this.titleInput = controls.createEl("input", {
      type: "text",
      value: this.currentTitle,
      cls: "ss-chat-settings-modal__model-input"
    });
    this.titleInput.style.flexGrow = "1";
    this.titleInput.style.minWidth = "0"; // Allows flex shrinking below content size

    this.titleInput.addEventListener("change", (e) => {
        this.currentTitle = (e.target as HTMLInputElement).value;
    });

    // Generate Title button (matching Change Model button style)
    this.generateTitleButton = controls.createEl("button", {
      text: "Generate Title",
      cls: "ss-chat-settings-modal__model-change-btn"
    });
    this.generateTitleButton.addEventListener("click", this.handleTitleGeneration);

    const isEmpty = (this.options.chatView?.messages.length ?? this.options.messages?.length ?? 0) === 0;
    this.generateTitleButton.disabled = isEmpty;
  }

  private createModelSection(containerEl: HTMLElement) {
    const section = containerEl.createDiv("ss-chat-settings-modal__section");
    section.createEl("h3", { text: "AI Model", cls: "ss-chat-settings-modal__section-title" });

    const controls = section.createDiv("ss-chat-settings-modal__model-controls");
    controls.style.display = "flex";
    controls.style.gap = "5px";
    controls.style.width = "100%";

    // Read-only input for model name
    const modelInput = controls.createEl("input", {
      type: "text",
      value: "",
      cls: "ss-chat-settings-modal__model-input",
      attr: { readonly: "true" }
    });
    modelInput.style.flexGrow = "1";
    modelInput.style.minWidth = "0"; // Allows flex shrinking below content size
    this.modelNameDisplay = modelInput; // reuse existing property for updates

    // Show the actual model name immediately if available
    if (this.currentModelId) {
      (this.modelNameDisplay as HTMLInputElement).value = getModelLabelWithProvider(this.currentModelId);
    } else if (this.options.plugin?.settings?.selectedModelId) {
      (this.modelNameDisplay as HTMLInputElement).value = getModelLabelWithProvider(this.options.plugin.settings.selectedModelId);
    } else {
      (this.modelNameDisplay as HTMLInputElement).value = "No model selected";
    }

    // Change Model button
    this.changeModelButton = controls.createEl("button", {
      text: "Change Model",
      cls: "ss-chat-settings-modal__model-change-btn"
    });
    this.changeModelButton.addEventListener("click", this.openModelSelectModal);

    // Initial update
    this.updateModelDisplay();
  }

  private createChatFontSizeSection(containerEl: HTMLElement) {
    const section = containerEl.createDiv("ss-chat-settings-modal__section");
    section.createEl("h3", { text: "Chat Size", cls: "ss-chat-settings-modal__section-title" });

    const sizeSetting = new Setting(section)
      .setName("Message Text Size")
      .setDesc("Change the text size for messages in this chat only.")
      .addDropdown(dropdown => {
        dropdown
          .addOption("small", "Small")
          .addOption("medium", "Medium")
          .addOption("large", "Large")
          .setValue(this.currentChatFontSize)
          .onChange(async (value: string) => {
            this.currentChatFontSize = value as any;
            if (this.options.chatView) {
              await this.options.chatView.setChatFontSize(this.currentChatFontSize);
            }
          });
      });
  }

  private createSystemPromptTypeSection(containerEl: HTMLElement, defaultsOnlyMode = false) {
    const section = containerEl.createDiv("ss-chat-settings-modal__section");
    section.createEl("h3", { text: "System Prompt Type", cls: "ss-chat-settings-modal__section-title" });

    const buttonContainer = section.createDiv("ss-chat-settings-modal__prompt-type-buttons");
    this.createPresetButtons(buttonContainer);

    this.selectedFileInfo = section.createDiv("ss-chat-settings-modal__prompt-type-details");

    const controlsContainer = section.createDiv("ss-chat-settings-modal__prompt-type-controls");

    // Create the change file button that will only be shown when custom type is selected
    this.changeFileButton = new ButtonComponent(controlsContainer)
      .setButtonText("Change Custom File...")
      .setClass("ss-chat-settings-modal__prompt-change-file-btn")
      .onClick(this.openCustomPromptSelector);
    // The visibility of this button is controlled in updatePresetButtons method

    // Initial update
    this.updateSelectedFileInfo();
    this.updatePresetButtons();
  }

  private createPromptEditorSection(containerEl: HTMLElement) {
    // Use section class for consistency
    const section = containerEl.createDiv("ss-chat-settings-modal__prompt-editor-section ss-chat-settings-modal__section");
    section.createEl("h3", { text: "System Prompt Preview/Edit", cls: "ss-chat-settings-modal__section-title" });

    this.promptTextEditor = section.createEl("textarea", {
      cls: "ss-chat-settings-modal__prompt-textarea",
      attr: {
        placeholder: "System prompt content will appear here..."
      }
    });

    this.promptTextEditor.addEventListener("input", () => {
      this.currentPrompt = this.promptTextEditor.value;
      // Consider if changing prompt should automatically set type to custom if it wasn't
      // Maybe only if they started from a preset?
      // For now, let's assume if they edit, it's custom unless they re-select a preset.
    });

    // Note about editing presets
    const noteEl = section.createDiv("ss-chat-settings-modal__prompt-editor-note");
    noteEl.setText("Note: Changes to built-in presets (General Use, Concise) apply only to this chat. To save edits permanently, select or save as a new custom prompt file.");
  }

  // New separate section for default settings that will appear at the end
  private createDefaultSettingsSection(containerEl: HTMLElement) {
    const section = containerEl.createDiv("ss-chat-settings-modal__default-settings-section ss-chat-settings-modal__section");

    // Create a container for the default settings section with proper styling
    const defaultSettingsContainer = section.createDiv("default-settings-container");
    defaultSettingsContainer.style.backgroundColor = "var(--background-secondary)";
    defaultSettingsContainer.style.padding = "12px";
    defaultSettingsContainer.style.borderRadius = "var(--radius-s)";
    defaultSettingsContainer.style.marginTop = "16px";

    // Add a heading for the section
    defaultSettingsContainer.createEl("h4", {
      text: "Default Settings",
      cls: "setting-item-heading"
    }).style.marginTop = "0";

    // Add clear descriptive text
    const defaultSettingsDescription = defaultSettingsContainer.createDiv();
    defaultSettingsDescription.innerHTML = "Configure the <strong>default model</strong> and <strong>system prompt type</strong> that will be used for all new chats.";
    defaultSettingsDescription.addClass("setting-item-description");
    defaultSettingsDescription.style.marginBottom = "12px";

    // Add the button with a clearer label
    this.changeDefaultButton = new ButtonComponent(defaultSettingsContainer)
      .setButtonText("Change Default Presets")
      .setCta()
      .onClick(this.openChangeDefaultPromptModal);
  }

  // --- Helper and Update Methods (Adjust classes if needed) ---

  private createPresetButtons(container: HTMLElement) {
    const presets: { id: "general-use" | "concise" | "custom"; label: string }[] = [
      { id: "general-use", label: "General Use Preset" },
      { id: "concise", label: "Concise Preset" },
      { id: "custom", label: "Custom Prompt" },
    ];

    presets.forEach(preset => {
      this.presetButtons[preset.id] = new ButtonComponent(container)
        .setButtonText(preset.label)
        .setClass("ss-preset-button") // Use class defined in new CSS
        .onClick(() => this.selectPreset(preset.id));
    });
  }

  private updatePresetButtons() {
    for (const id in this.presetButtons) {
      if (this.presetButtons.hasOwnProperty(id)) {
        const isActive = id === this.currentType;
        this.presetButtons[id].buttonEl.toggleClass("is-active", isActive);
      }
    }
    // Show/hide change file button based on type
    if (this.changeFileButton) {
      this.changeFileButton.buttonEl.style.display = this.currentType === 'custom' ? 'block' : 'none';
    }
  }

  private updateSelectedFileInfo() {
    if (!this.selectedFileInfo) return;

    this.selectedFileInfo.empty();
    if (this.currentType === "custom") {
      if (this.currentPath) {
         // Check if the custom file still exists
         const file = this.app.vault.getAbstractFileByPath(this.currentPath);
         if (!file) {
           // File doesn't exist, fall back to general-use
           this.currentType = 'general-use';
           this.currentPath = undefined;
           this.currentPrompt = GENERAL_USE_PRESET.systemPrompt;
           this.selectedFileInfo.createEl("span", { text: "General Use (auto-switched from missing custom file)", cls: "ss-text-warning" });
         } else {
           // Use path.basename or string split to get basename
           const basename = this.currentPath.split('/').pop() || this.currentPath;
           this.selectedFileInfo.createEl("span", { text: `Selected: ${basename}` });
         }
      } else {
        this.selectedFileInfo.createEl("span", { text: "No custom file selected. Please choose one.", cls: "ss-text-warning" });
      }
    } else {
       let presetLabel: string;
       const normalizedType = normalizeDesktopPromptSelectionType(this.currentType);
       if (normalizedType === 'general-use') {
         presetLabel = 'General Use';
       } else if (normalizedType === 'concise') {
         presetLabel = 'Concise';
       } else {
         // Handle invalid/unknown system prompt types
         const validTypes = ['general-use', 'concise', 'custom'];

         if (!validTypes.includes(normalizedType as string)) {
           this.currentType = 'general-use';
           this.currentPrompt = GENERAL_USE_PRESET.systemPrompt;
           presetLabel = 'General Use (auto-switched from invalid type)';
         } else {
           presetLabel = 'General Use';
         }
       }
       this.selectedFileInfo.createEl("span", { text: `Using ${presetLabel} Preset` });
    }

    // Add default prompt info - Show the *current* selection as the default in defaults-only mode
    let defaultType: string;
    let defaultPath: string | undefined;
    if (this.options.mode === "defaults-only") {
      defaultType = this.currentType;
      defaultPath = this.currentPath;
    } else {
      defaultType = normalizeDesktopPromptSelectionType(this.options.plugin.settings.systemPromptType || 'general-use');
      defaultPath = this.options.plugin.settings.systemPromptPath;
    }

    const defaultDesc = this.selectedFileInfo.createEl("div", { cls: "ss-modal-description" });

    // Format default info text
    let defaultDisplayText = "";
    if (defaultType === 'custom' && defaultPath) {
      const fileName = defaultPath.split('/').pop() || 'Custom';
      defaultDisplayText = `Custom: ${fileName}`;
    } else {
      defaultDisplayText = defaultType === 'general-use' ? 'General Use' :
                         defaultType.charAt(0).toUpperCase() + defaultType.slice(1);
    }

    defaultDesc.setText(`Default for new chats: ${defaultDisplayText}`);
  }

  private async loadInitialPrompt() {
      try {
          const normalizedType = normalizeDesktopPromptSelectionType(this.currentType);
          let promptContent = "";
          if (normalizedType === "custom" && this.currentPath) {
              promptContent = await this.systemPromptService.getSystemPromptContent("custom", this.currentPath);
          } else if (normalizedType === "custom") {
             promptContent = this.currentPrompt || "";
          } else {
              promptContent = await this.systemPromptService.getSystemPromptContent(normalizedType);
          }

          this.currentPrompt = promptContent;
          this.currentType = normalizedType;
          if (this.promptTextEditor) {
              this.promptTextEditor.value = this.currentPrompt;
          }
      } catch (error) {
          new Notice("Could not load system prompt content.", 10000);
          if (this.promptTextEditor) {
              this.promptTextEditor.value = "Error loading prompt.";
          }
      }
  }

  private selectPreset = async (type: "general-use" | "concise" | "agent" | "custom") => {
    const normalizedType = normalizeDesktopPromptSelectionType(type);
    this.currentType = normalizedType;

    if (normalizedType === "general-use") {
        this.currentPrompt = GENERAL_USE_PRESET.systemPrompt;
        this.currentPath = undefined;
    } else if (normalizedType === "concise") {
        this.currentPrompt = CONCISE_PRESET.systemPrompt;
        this.currentPath = undefined;
    } else if (normalizedType === "custom") {
        // If switching TO custom, prompt user to select a file immediately
        // unless a path is already somehow defined (e.g., initial state)
        if (!this.currentPath) {
            this.openCustomPromptSelector();
            // Don't load content yet, wait for selection
            this.currentPrompt = ""; // Clear editor until file selected
        } else {
           // If path exists, load its content
           await this.loadInitialPrompt();
        }
    }

    // Update UI elements
    if (this.promptTextEditor) {
      this.promptTextEditor.value = this.currentPrompt; // Update editor
    }
    this.updatePresetButtons();
    this.updateSelectedFileInfo();

    // Apply to the owning ChatView immediately so status/indicators stay in sync
    if (this.options.chatView) {
      this.options.chatView.systemPromptType = this.currentType;
      this.options.chatView.systemPromptPath = this.currentType === 'custom' ? this.currentPath : undefined;
      this.options.chatView.currentPrompt = this.currentPrompt;
      try {
        await this.options.chatView.saveChat();
        await this.options.chatView.updateSystemPromptIndicator();
        if (this.options.chatView.messages.length === 0) {
          this.options.chatView.displayChatStatus();
        }
      } catch {}
    }

    // If in defaults-only mode, immediately update plugin settings and persist
    if (this.options.mode === "defaults-only" && this.options.plugin) {
      await this.options.plugin.getSettingsManager().updateSettings({
        systemPromptType: this.currentType,
        systemPromptPath: this.currentPath ?? ""
      });
      this.options.plugin.emitter?.emit?.('settingsChanged');
      new Notice("Default system prompt updated.", 2000);
    }
  }

  private openCustomPromptSelector = () => {
    new CustomPromptFileSuggestModal(
      this.app,
      this.systemPromptService,
      async (file) => { // file is { path: string, name: string }
        this.currentPath = file.path;
        this.currentType = "custom"; // Ensure type is set
        await this.loadInitialPrompt(); // Load content of selected file
        this.updatePresetButtons();
        this.updateSelectedFileInfo();

        // Apply to ChatView immediately
        if (this.options.chatView) {
          this.options.chatView.systemPromptType = this.currentType;
          this.options.chatView.systemPromptPath = this.currentPath;
          this.options.chatView.currentPrompt = this.currentPrompt;
          try {
            await this.options.chatView.saveChat();
            await this.options.chatView.updateSystemPromptIndicator();
            if (this.options.chatView.messages.length === 0) {
              this.options.chatView.displayChatStatus();
            }
          } catch {}
        }
      }
    ).open();
  }

  private openChangeDefaultPromptModal = () => {
    const modal = new (require("./DefaultChatPresetsModal").DefaultChatPresetsModal)(this.app, this.options.plugin);
    modal.open();
  }

  private async updateModelDisplay() {
    if (!this.modelNameDisplay || !this.currentModelId) return;

    try {
      const canonicalId = ensureCanonicalId(this.currentModelId);
      const displayLabel = getModelLabelWithProvider(canonicalId);
      (this.modelNameDisplay as HTMLInputElement).value = displayLabel;

    } catch (error) {
      (this.modelNameDisplay as HTMLInputElement).value = getModelLabelWithProvider(this.currentModelId); // Fallback
    }
  }

  private openModelSelectModal = async () => {
       if (!this.options.plugin) {
         new Notice("Cannot change model: plugin instance not available", 10000);
         return;
       }

      const modelSelectionOptions = {
        app: this.app,
        plugin: this.options.plugin,
        currentModelId: this.currentModelId || "",
        isAgentPromptActive: false, // No longer restrict models based on prompt type
        onSelect: async (result: ModelSelectionResult) => {
          const canonicalId = ensureCanonicalId(result.modelId);
          
          // No longer handle synchronization between models and prompts
          if (this.options.onModelSelect) {
            try {
              await this.options.onModelSelect(canonicalId);
              this.currentModelId = canonicalId;
              try {
                const useLatestEverywhere = this.options.plugin.settings.useLatestModelEverywhere ?? true;
                const isStandardMode = this.options.plugin.settings.settingsMode !== 'advanced';
                if (useLatestEverywhere || isStandardMode) {
                  await this.options.plugin.getSettingsManager().updateSettings({ selectedModelId: canonicalId });
                }
              } catch {}
              this.updateModelDisplay();
            } catch (error) {
              new Notice("Failed to select model", 10000);
            }
          } else {
             this.currentModelId = canonicalId;
             try {
               const useLatestEverywhere = this.options.plugin.settings.useLatestModelEverywhere ?? true;
               const isStandardMode = this.options.plugin.settings.settingsMode !== 'advanced';
               if (useLatestEverywhere || isStandardMode) {
                 await this.options.plugin.getSettingsManager().updateSettings({ selectedModelId: canonicalId });
               }
             } catch {}
             this.updateModelDisplay();
          }
        }
      };

      const modal = new StandardModelSelectionModal(modelSelectionOptions);
      modal.open();
    };

  private handleTitleGeneration = async () => {
      if (this.isGeneratingTitle || !this.options.plugin) return;

      this.isGeneratingTitle = true;
      this.generateTitleButton.setText("Generating...");
      this.generateTitleButton.disabled = true;

      let newTitle: string | undefined;
      try {
          newTitle = await this.titleGenerationService.generateTitle(this.options.messages ?? []);
          if (newTitle) {
              newTitle = newTitle.trim();
              this.titleInput.value = newTitle;
              this.currentTitle = newTitle;
              new Notice("Title generated!", 2000);
          } else {
              new Notice("Could not generate title.", 5000);
          }
      } catch (error: any) {
          const isBenign2000 = (error?.error === 2000 || error?.message === '2000') && newTitle;
          if (isBenign2000) {
              // Suppress console error and user notice for benign 2000 error when title was generated
          } else {
              if (error?.error === 2000 || error?.message === '2000') {
                  new Notice("Title generation failed (error 2000).", 10000);
              } else {
                  new Notice("Failed to generate title.", 10000);
              }
          }
      } finally {
          this.isGeneratingTitle = false;
          this.generateTitleButton.setText("Generate Title");
          this.generateTitleButton.disabled = false;
      }
  };

  // --- Footer removed ---

  async onClose() {
    // Remove event listener when modal is closed
    if (this.settingsChangedListener && this.options.plugin && this.options.plugin.emitter) {
      this.options.plugin.emitter.off('settingsChanged');
      this.settingsChangedListener = null;
    }

    const { contentEl } = this;
    contentEl.empty();

    // Save current state automatically on close
    const result: ChatSystemPromptResult = {
      type: normalizeDesktopPromptSelectionType(this.currentType),
      prompt: this.currentPrompt,
      path: this.currentPath,
      modelId: this.currentModelId,
      title: this.currentTitle
    };

    // Validate before saving (e.g., custom type needs path)
    if (result.type === 'custom' && !result.path) {
      new Notice("Please select a custom prompt file before saving.", 5000);
      if (this.resolvePromise) this.resolvePromise(null);
      return;
    }

    try {
      // Update ChatView state
      if (this.options.chatView) {
        this.options.chatView.systemPromptType = result.type;
        this.options.chatView.systemPromptPath = result.path;
        this.options.chatView.currentPrompt = result.prompt;
        this.options.chatView.clearPiSessionState({ save: false });
        // Apply model change via ChatView API if provided; this persists and updates indicators
        if (result.modelId && typeof this.options.chatView.setSelectedModelId === 'function') {
          await this.options.chatView.setSelectedModelId(result.modelId);
        } else {
          this.options.chatView.selectedModelId = result.modelId || (this.options.currentModelId ?? "");
        }

        const newTitle = result.title || (this.options.chatTitle ?? "");
        // Update tab title and save chat
        await this.options.chatView.setTitle(newTitle, true);
        // Persist prompt/path change
        await this.options.chatView.saveChat();

        // Force refresh tab header title immediately
        this.options.chatView.leaf.setViewState(this.options.chatView.leaf.getViewState());

        // Update UI elements
        this.options.chatView.updateModelIndicator();
        this.options.chatView.updateSystemPromptIndicator();
        // Keep the empty-chat status panel in sync
        if (this.options.chatView.messages.length === 0) {
          this.options.chatView.displayChatStatus();
        }
      }

      // Promote system prompt choice to defaults if policy is enabled or Standard mode
      if (this.options.plugin) {
        try {
          const useLatestPrompt = this.options.plugin.settings.useLatestSystemPromptForNewChats ?? true;
          const isStandardMode = this.options.plugin.settings.settingsMode !== 'advanced';
          if (useLatestPrompt || isStandardMode) {
            await this.options.plugin.getSettingsManager().updateSettings({
              systemPromptType: result.type,
              systemPromptPath: result.type === 'custom' ? (result.path || "") : ""
            });
            this.options.plugin.emitter?.emit?.('systemPromptSettingsChanged');
          }
        } catch {}
      }

      if (this.resolvePromise) this.resolvePromise(result);
    } catch (error) {
      new Notice("Failed to save settings.", 10000);
      if (this.resolvePromise) this.resolvePromise(null);
    }
  }
  // Promise interface for awaiting result
  private resolvePromise: ((value: ChatSystemPromptResult | null) => void) | null = null;
  openModal(): Promise<ChatSystemPromptResult | null> {
      return new Promise((resolve) => {
          this.resolvePromise = resolve;
          this.open();
      });
  }
}

// Helper function to open the modal
export function showStandardChatSettingsModal(
  app: App,
  options: ChatSystemPromptModalOptions // Now takes options object
): Promise<ChatSystemPromptResult | null> {
  const modal = new StandardChatSettingsModal(app, options);
  return modal.openModal();
}
