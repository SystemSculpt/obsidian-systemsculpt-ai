import { App, Modal, Setting, Notice, SuggestModal, TFile } from "obsidian";
import SystemSculptPlugin from "../main";
import { getDisplayName, ensureCanonicalId, parseCanonicalId, getModelLabelWithProvider } from "../utils/modelUtils";
import { StandardModelSelectionModal, ModelSelectionResult } from "./StandardModelSelectionModal";
import { SystemPromptService } from "../services/SystemPromptService";

/**
 * Custom file suggester modal for system prompt files
 */
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
    const files = await this.systemPromptService.getCustomPromptFiles();
    if (!query) {
      return files;
    }
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

export class DefaultChatPresetsModal extends Modal {
  private plugin: SystemSculptPlugin;
  private systemPromptService: SystemPromptService;
  private promptTypeBtns: Record<string, HTMLButtonElement> = {};
  private customPromptInfo: HTMLElement;
  private defaultInfoEl: HTMLElement;

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app);
    this.plugin = plugin;
    this.systemPromptService = SystemPromptService.getInstance(this.app, () => this.plugin.settings);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Default Chat Presets" });

    contentEl.createEl("p", {
      text: "Set your default AI model and system prompt type for new chats. These presets will be used every time you start a new, fresh chat."
    });

    // Section: Default AI Model
    const modelSection = contentEl.createDiv("modal-section");
    modelSection.createEl("h3", { text: "Default AI Model" });

    new Setting(modelSection)
      .setName("AI Model")
      .setDesc("Select the default model for new chats")
      .addText(text => {
        text.setPlaceholder("Model")
          .setValue(this.plugin.settings.selectedModelId
            ? getModelLabelWithProvider(ensureCanonicalId(this.plugin.settings.selectedModelId))
            : "No model selected")
          .setDisabled(true);
      })
      .addButton(button => {
        button.setButtonText("Change Model")
          .setCta()
          .onClick(() => this.openModelSelectModal());
      });

    // Section: Default Title Generation Model
    const titleGenModelSection = contentEl.createDiv("modal-section");
    titleGenModelSection.createEl("h3", { text: "Default Title Generation Model" });

    new Setting(titleGenModelSection)
      .setName("Title Generation Model")
      .setDesc("Select the default model for generating chat titles")
      .addText(text => {
        text.setPlaceholder("Model")
          .setValue(this.plugin.settings.titleGenerationModelId
            ? getModelLabelWithProvider(ensureCanonicalId(this.plugin.settings.titleGenerationModelId))
            : "Same as chat model")
          .setDisabled(true);
      })
      .addButton(button => {
        button.setButtonText("Change Model")
          .setCta()
          .onClick(() => this.openTitleGenModelSelectModal());
      });

    // Section: Default System Prompt Type
    const promptSection = contentEl.createDiv("modal-section");
    promptSection.createEl("h3", { text: "Default System Prompt Type" });

    // Info element to show current default
    this.defaultInfoEl = promptSection.createEl("div", {
      cls: "setting-item-description",
    });
    await this.updateDefaultInfo();

    const promptSetting = new Setting(promptSection)
      .setName("System Prompt")
      .setDesc("Choose the default system prompt type for new chats");

    const buttonContainer = promptSetting.controlEl.createDiv({ cls: "ss-modal-button-container--grid" });

    // Create buttons for each prompt type (agent prompt removed; controlled via Agent Mode toggle)
    ["general-use", "concise", "custom"].forEach((type) => {
      const displayText = type === "general-use" ? "General Use" : type.charAt(0).toUpperCase() + type.slice(1);

      // Create button with appropriate initial class
      const button = buttonContainer.createEl("button", {
        text: displayText,
        cls: this.plugin.settings.systemPromptType === type ? "mod-cta" : ""
      });

      // Store reference to button
      this.promptTypeBtns[type] = button;

      button.onclick = async () => {
        // Update settings using SettingsManager
        if (type !== "custom") {
          // For non-custom types, update both settings at once
          await this.plugin.getSettingsManager().updateSettings({
            systemPromptType: type as any,
            systemPromptPath: ""
          });
          await this.saveAndNotify(displayText);
        } else {
          // For custom type, just update the type for now
          await this.plugin.getSettingsManager().updateSettings({
            systemPromptType: type as any
          });

          // Immediately update button styling
          this.updateButtonStyles();

          // Open file picker instead of saving immediately
          this.openCustomPromptPicker();
        }
      };
    });

    // Add a container to show the currently selected custom prompt
    this.customPromptInfo = promptSection.createDiv("custom-prompt-info ss-modal-custom-prompt-info");
    this.updateCustomPromptInfo();
  }

  private async saveAndNotify(promptName: string) {
    // Settings are already updated in the plugin.settings object
    // Use SettingsManager to save them
    await this.plugin.getSettingsManager().saveSettings();

    // Emit settings changed event to update other views
    this.plugin.emitter?.emit?.('settingsChanged');

    new Notice(`Default system prompt set to ${promptName}`, 2000);

    // Update UI components
    this.updateButtonStyles();
    this.updateCustomPromptInfo();
    await this.updateDefaultInfo();
  }

  private async updateDefaultInfo() {
    const type = this.plugin.settings.systemPromptType;
    let displayText = "";

    // CRITICAL: Check if user has "agent" as their default system prompt type.
    // Since Agent Mode is now per-chat only, this is no longer valid as a default.
    if (type === "agent") {
      await this.plugin.getSettingsManager().updateSettings({
        systemPromptType: 'general-use',
        systemPromptPath: ''
      });
      displayText = "General Use (auto-switched from Agent Mode - now per-chat only)";
    } else if (type === "general-use") {
      displayText = "General Use";
    } else if (type === "concise") {
      displayText = "Concise";
    } else if (type === "custom") {
      if (this.plugin.settings.systemPromptPath) {
        // Check if the custom file still exists
        const file = this.app.vault.getAbstractFileByPath(this.plugin.settings.systemPromptPath);
        if (!file) {
          // File doesn't exist, fall back to general-use
          await this.plugin.getSettingsManager().updateSettings({
            systemPromptType: 'general-use',
            systemPromptPath: ''
          });
          displayText = "General Use (auto-switched from missing custom file)";
        } else {
          const pathParts = this.plugin.settings.systemPromptPath.split("/");
          const fileName = pathParts[pathParts.length - 1];
          displayText = `Custom: ${fileName}`;
        }
      } else {
        displayText = "Custom (no file selected)";
      }
    } else {
      // Handle invalid/unknown system prompt types (excluding "agent" which is now handled above)
      const validDefaultTypes = ['general-use', 'concise', 'custom']; // Removed 'agent' from valid defaults
      if (!validDefaultTypes.includes(type as string)) {
        // Unknown or invalid type, fall back to general-use
        await this.plugin.getSettingsManager().updateSettings({
          systemPromptType: 'general-use',
          systemPromptPath: ''
        });
        displayText = "General Use (auto-switched from invalid type)";
      } else {
        displayText = "General Use";
      }
    }

    this.defaultInfoEl.setText(`Current default for new chats: ${displayText}`);
  }

  private updateButtonStyles() {
    // Reset all buttons - remove all styling classes
    Object.values(this.promptTypeBtns).forEach(btn => {
      btn.removeClass("mod-cta");
      btn.removeClass("mod-primary");
    });

    // Apply mod-cta class to the currently selected button
    const currentType = this.plugin.settings.systemPromptType;
    if (this.promptTypeBtns[currentType]) {
      this.promptTypeBtns[currentType].addClass("mod-cta");
    }
  }

  private updateCustomPromptInfo() {
    this.customPromptInfo.empty();

    if (this.plugin.settings.systemPromptType === "custom") {
      this.customPromptInfo.addClass("ss-modal-custom-prompt-info--visible");

      if (this.plugin.settings.systemPromptPath) {
        const pathParts = this.plugin.settings.systemPromptPath.split("/");
        const fileName = pathParts[pathParts.length - 1];

        this.customPromptInfo.createEl("div", {
          text: `Selected custom prompt: ${fileName}`,
          cls: "setting-item-description"
        });

        // Add button to change custom file
        const changeBtn = this.customPromptInfo.createEl("button", {
          text: "Change Custom Prompt",
          cls: "mod-warning ss-modal-button--small"
        });
        changeBtn.onclick = () => this.openCustomPromptPicker();
      } else {
        this.customPromptInfo.createEl("div", {
          text: "No custom prompt selected. Please choose one.",
          cls: "setting-item-description mod-warning"
        });

        // Add button to pick a custom file
        const selectBtn = this.customPromptInfo.createEl("button", {
          text: "Select Custom Prompt",
          cls: "mod-cta ss-modal-button--small"
        });
        selectBtn.onclick = () => this.openCustomPromptPicker();
      }
    } else {
      this.customPromptInfo.removeClass("ss-modal-custom-prompt-info--visible");
    }
  }

  private openCustomPromptPicker() {
    new CustomPromptFileSuggestModal(
      this.app,
      this.systemPromptService,
      async (file) => {
        await this.plugin.getSettingsManager().updateSettings({
          systemPromptPath: file.path
        });
        await this.saveAndNotify(`Custom: ${file.name}`);
      }
    ).open();
  }

  private openModelSelectModal() {
    const modal = new StandardModelSelectionModal({
      app: this.app,
      plugin: this.plugin,
      currentModelId: this.plugin.settings.selectedModelId || "",
      onSelect: async (result: ModelSelectionResult) => {
        try {
          const canonicalId = ensureCanonicalId(result.modelId);
          await this.plugin.getSettingsManager().updateSettings({
            selectedModelId: canonicalId
          });

          // Emit settings changed event
          this.plugin.emitter?.emit?.('settingsChanged');

          new Notice("Default model updated successfully.", 3000);

          // Refresh the model display in the modal instead of closing
          const input = this.contentEl.querySelector("input[type='text']") as HTMLInputElement;
          if (input) {
            input.value = getModelLabelWithProvider(canonicalId);
          }
        } catch (error) {
          new Notice("Failed to update default model", 10000);
        }
      }
    });
    modal.open();
  }

  private openTitleGenModelSelectModal() {
    const modal = new StandardModelSelectionModal({
      app: this.app,
      plugin: this.plugin,
      currentModelId: this.plugin.settings.titleGenerationModelId || this.plugin.settings.selectedModelId || "",
      onSelect: async (result: ModelSelectionResult) => {
        try {
          const canonicalId = ensureCanonicalId(result.modelId);
          const parsed = parseCanonicalId(canonicalId);
          if (parsed) {
            await this.plugin.getSettingsManager().updateSettings({
              titleGenerationModelId: canonicalId,
              titleGenerationProviderId: parsed.providerId
            });
          } else {
            await this.plugin.getSettingsManager().updateSettings({
              titleGenerationModelId: canonicalId
            });
          }

          // Emit settings changed event
          this.plugin.emitter?.emit?.('settingsChanged');

          new Notice("Title generation model updated successfully.", 3000);

          // Refresh the title generation model display in the modal
          const titleGenModelInput = this.contentEl.querySelectorAll("input[type='text']")[1] as HTMLInputElement;
          if (titleGenModelInput) {
            titleGenModelInput.value = getModelLabelWithProvider(canonicalId);
          }
        } catch (error) {
          new Notice("Failed to update title generation model", 10000);
        }
      }
    });
    modal.open();
  }
}