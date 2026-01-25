import { App, setIcon, ToggleComponent } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { CustomProvider } from "../types/llm";
import SystemSculptPlugin from "../main";
import { AI_PROVIDERS, LOCAL_SERVICES } from '../constants/externalServices';

interface CustomProviderModalOptions {
  name?: string;
  endpoint?: string;
  apiKey?: string;
  isEnabled?: boolean;
  existingId?: string;
  onSave: (provider: CustomProvider) => void;
  onCancel?: () => void;
}

/**
 * Modal for adding or editing a custom provider
 */
export class CustomProviderModal extends StandardModal {
  private plugin: SystemSculptPlugin;
  private options: CustomProviderModalOptions;
  
  // Form fields
  private nameInput: HTMLInputElement;
  private endpointInput: HTMLInputElement;
  private apiKeyInput: HTMLInputElement;
  private providerToggleComponent: ToggleComponent;
  private isToggleEnabled: boolean;
  
  constructor(app: App, plugin: SystemSculptPlugin, options: CustomProviderModalOptions) {
    super(app);
    this.plugin = plugin;
    this.options = options;
    
    // Initialize isToggleEnabled. Default to true for new providers.
    this.isToggleEnabled = options.isEnabled !== undefined ? options.isEnabled : true;
    
    // Add the custom provider modal class
    this.modalEl.addClass("systemsculpt-custom-provider-modal");
  }
  
  onOpen() {
    super.onOpen();
    
    // Set modal size
    this.setSize("small");
    
    // Add title - either "Add Provider" or "Edit Provider"
    const isEditing = !!this.options.existingId;
    this.addTitle(isEditing ? "Edit Provider" : "Add Provider", 
      isEditing ? "Update your API provider connection" : "Connect to a new API provider");
    
    // Create the form
    this.createForm();
    
    // Add action buttons
    this.addActionButton("Cancel", () => {
      if (this.options.onCancel) {
        this.options.onCancel();
      }
      this.close();
    }, false);
    
    this.addActionButton(isEditing ? "Update" : "Add Provider", () => {
      this.saveProvider();
    }, true);
  }
  
  private createForm() {
    const formContainer = this.contentEl.createDiv("systemsculpt-custom-provider-form");
    
    // Provider presets section (for quick setup)
    if (!this.options.existingId) {
      this.createPresetSection(formContainer);
    }
    
    // Provider name field
    const nameGroup = formContainer.createDiv("systemsculpt-custom-provider-form-group");
    nameGroup.createEl("label", { text: "Provider Name" });
    this.nameInput = nameGroup.createEl("input", {
      type: "text",
      placeholder: "e.g., OpenAI, Anthropic, etc.",
      value: this.options.name || ""
    });
    
    // Endpoint URL field
    const endpointGroup = formContainer.createDiv("systemsculpt-custom-provider-form-group");
    endpointGroup.createEl("label", { text: "API Endpoint" });
    this.endpointInput = endpointGroup.createEl("input", {
      type: "text",
      placeholder: "https://api.example.com/v1",
      value: this.options.endpoint || ""
    });
    
    // API Key field
    const apiKeyGroup = formContainer.createDiv("systemsculpt-custom-provider-form-group");
    
    const apiKeyLabel = apiKeyGroup.createEl("label");
    apiKeyLabel.setText("API Key");
    
    // Container for API Key Input and Show/Hide Button
    // Use the same class as in settings for consistent styling if defined globally
    const apiKeyContainer = apiKeyGroup.createDiv("systemsculpt-api-key-input-container"); 
    this.apiKeyInput = apiKeyContainer.createEl("input", {
      type: "password",
      placeholder: "Enter your API key", // Initial placeholder
      value: this.options.apiKey || ""
    });
    
    const showHideButton = apiKeyContainer.createEl("button", {
      cls: "mod-small systemsculpt-api-key-toggle-visibility", // Use class from settings.css
      attr: { "aria-label": "Show/Hide API Key" }
    });
    setIcon(showHideButton, "eye-off"); 
    
    showHideButton.addEventListener("click", (e) => {
      e.preventDefault(); 
      if (this.apiKeyInput.type === "password") {
        this.apiKeyInput.type = "text";
        setIcon(showHideButton, "eye");
      } else {
        this.apiKeyInput.type = "password";
        setIcon(showHideButton, "eye-off");
      }
    });
    
    // Function to update API key label and placeholder based on provider name/endpoint
    const updateApiKeyAppearance = () => {
      const name = this.nameInput.value.trim();
      const endpoint = this.endpointInput.value.trim().toLowerCase();
      const isLocal = endpoint.includes("localhost") || endpoint.includes("127.0.0.1");
      const isOptionalPreset = name === "Ollama" || name === "LM Studio";
      const isGenericCustom = name === "Custom Provider";
      
      const isEffectivelyOptional = isLocal || isOptionalPreset || (isGenericCustom && !this.apiKeyInput.value); // If custom and no key yet, assume optional for placeholder
      
      this.apiKeyInput.placeholder = isEffectivelyOptional ? "Enter your API key (optional)" : "Enter your API key";
      
      const currentOptionalSpan = apiKeyLabel.querySelector(".systemsculpt-optional-field-text");
      if (isEffectivelyOptional && !currentOptionalSpan) {
        apiKeyLabel.createSpan({ 
          text: " (optional)", 
          cls: "systemsculpt-optional-field-text"
        });
      } else if (!isEffectivelyOptional && currentOptionalSpan) {
        currentOptionalSpan.remove();
      }
    };

    // Update API key label and placeholder when provider name or endpoint changes
    this.registerDomEvent(this.nameInput, "input", updateApiKeyAppearance);
    this.registerDomEvent(this.endpointInput, "input", updateApiKeyAppearance);
    updateApiKeyAppearance(); // Initial call

    // Enabled Toggle - MODIFIED SECTION
    const enabledGroup = formContainer.createDiv("systemsculpt-custom-provider-form-group systemsculpt-setting-item"); // Use setting-item for Obsidian-like layout
    
    // This container will be managed by Setting
    const settingItemInfo = enabledGroup.createDiv("setting-item-info");
    settingItemInfo.createDiv({text: "Enable Provider", cls: "setting-item-name"});
    settingItemInfo.createDiv({text: "Make this provider available for use in the plugin.", cls: "setting-item-description"});

    const controlContainer = enabledGroup.createDiv("setting-item-control");
    this.providerToggleComponent = new ToggleComponent(controlContainer)
        .setValue(this.isToggleEnabled)
        .onChange((value) => {
            this.isToggleEnabled = value;
        });
  }
  
  private createPresetSection(container: HTMLElement) {
    const presetsSection = container.createDiv("systemsculpt-custom-provider-presets");
    presetsSection.createEl("label", { text: "Quick Setup" });
    
    const presetButtons = presetsSection.createDiv("systemsculpt-custom-provider-preset-buttons");
    
    this.createPresetButton(presetButtons, "OpenAI", AI_PROVIDERS.OPENAI.BASE_URL, "sparkles");
    this.createPresetButton(presetButtons, "Anthropic", AI_PROVIDERS.ANTHROPIC.BASE_URL, "bot"); // Corrected Anthropic endpoint
    this.createPresetButton(presetButtons, "OpenRouter", AI_PROVIDERS.OPENROUTER.BASE_URL, "network");
    this.createPresetButton(presetButtons, "MiniMax", AI_PROVIDERS.MINIMAX.BASE_URL, "globe");
    this.createPresetButton(presetButtons, "Kimi K2 (Moonshot)", AI_PROVIDERS.MOONSHOT.BASE_URL, "rocket");
    this.createPresetButton(presetButtons, "Groq", AI_PROVIDERS.GROQ.BASE_URL, "gauge");
    this.createPresetButton(presetButtons, "Ollama", LOCAL_SERVICES.OLLAMA.BASE_URL, "layers");
    this.createPresetButton(presetButtons, "LM Studio", LOCAL_SERVICES.LM_STUDIO.BASE_URL, "cpu");

    // Detect local providers button
    const detectBtn = presetButtons.createEl("button", {
      text: "Detect Local Providers",
      cls: "mod-small systemsculpt-preset-button"
    });
    const iconSpan = detectBtn.createSpan({ cls: "systemsculpt-preset-icon" });
    setIcon(iconSpan, "radar");
    detectBtn.prepend(iconSpan);
    detectBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        detectBtn.setAttribute("disabled", "true");
        detectBtn.textContent = "Scanning…";
        const { scanLocalLLMProviders } = await import("../services/providers/LocalLLMScanner");
        const options = await scanLocalLLMProviders();
        detectBtn.textContent = "Detect Local Providers";
        detectBtn.removeAttribute("disabled");
        if (!options || options.length === 0) {
          return; // silently ignore here; the Add Provider modal isn't a good place for notices
        }
        // Prefer LM Studio over Ollama when both are present; prefill name/endpoint
        const preferred = options.find(o => o.type === 'lmstudio') || options[0];
        this.nameInput.value = preferred.type === 'ollama' ? 'Ollama' : 'LM Studio';
        this.endpointInput.value = preferred.endpoint;
        this.nameInput.dispatchEvent(new Event('input'));
        this.endpointInput.dispatchEvent(new Event('input'));
        this.apiKeyInput.focus();
      } catch (_) {
        detectBtn.textContent = "Detect Local Providers";
        detectBtn.removeAttribute("disabled");
      }
    });
  }
  
  private createPresetButton(container: HTMLElement, name: string, endpoint: string, icon: string) {
    const buttonEl = container.createEl("button", {
      text: name,
      cls: "mod-small systemsculpt-preset-button" // Added specific class for styling presets
    });
    const iconSpan = buttonEl.createSpan({ cls: "systemsculpt-preset-icon" });
    setIcon(iconSpan, icon);
    buttonEl.prepend(iconSpan); 
    
    buttonEl.addEventListener("click", (e) => {
      e.preventDefault();
      this.nameInput.value = name;
      this.endpointInput.value = endpoint;
      this.nameInput.dispatchEvent(new Event('input')); // Trigger update for API key field appearance
      this.endpointInput.dispatchEvent(new Event('input')); 
      this.apiKeyInput.focus();
    });
  }
  
  private saveProvider() {
    const name = this.nameInput.value.trim();
    const endpoint = this.endpointInput.value.trim();
    const apiKey = this.apiKeyInput.value.trim();
    
    if (!name) {
      this.showValidationError(this.nameInput, "Provider name is required");
      return;
    }
    
    if (!endpoint) {
      this.showValidationError(this.endpointInput, "API endpoint is required");
      return;
    }
    
    const isLocal = endpoint.toLowerCase().includes("localhost") || endpoint.toLowerCase().includes("127.0.0.1");
    const isOptionalPreset = name === "Ollama" || name === "LM Studio";
    const isGenericCustom = name === "Custom Provider";
    const isApiKeyEffectivelyOptional = isLocal || isOptionalPreset || isGenericCustom;
          
    if (!apiKey && !isApiKeyEffectivelyOptional) {
      this.showValidationError(this.apiKeyInput, "API key is required for this provider/endpoint");
      return;
    }
    
    const existingProviders = this.plugin.settings.customProviders || [];
    const otherProviders = this.options.existingId 
      ? existingProviders.filter(p => p.id !== this.options.existingId)
      : existingProviders;
    
    const duplicateName = otherProviders.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (duplicateName) {
      this.showValidationError(this.nameInput, `A provider with the name "${name}" already exists`);
      return;
    }
    
    // Allow duplicate endpoints if one of them is a common local one like Ollama/LMStudio default
    const commonLocalEndpoints = [LOCAL_SERVICES.OLLAMA.BASE_URL, LOCAL_SERVICES.LM_STUDIO.BASE_URL];
    if (!commonLocalEndpoints.some(e => e.toLowerCase() === endpoint.toLowerCase())) {
        const duplicateEndpoint = otherProviders.find(p => p.endpoint.toLowerCase() === endpoint.toLowerCase());
        if (duplicateEndpoint) {
          this.showValidationError(this.endpointInput, `A provider with this endpoint already exists`);
          return;
        }
    }
    
    const provider: CustomProvider = {
      id: this.options.existingId || `custom-${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
      name,
      endpoint,
      apiKey,
      isEnabled: this.isToggleEnabled 
    };
    
    this.options.onSave(provider);
    this.close();
  }
  
  private showValidationError(inputEl: HTMLInputElement, message: string) {
    const formGroup = inputEl.closest(".systemsculpt-custom-provider-form-group");
    if (!formGroup) return;
    
    formGroup.addClass("error");
    
    let validationEl = formGroup.querySelector(".systemsculpt-custom-provider-form-validation");
    if (!validationEl) {
      validationEl = formGroup.createDiv({ cls: "systemsculpt-custom-provider-form-validation" });
    }
    validationEl.textContent = message;
    inputEl.focus();
    
    const clearError = () => {
      formGroup.removeClass("error");
      if (validationEl) {
        validationEl.remove();
      }
      inputEl.removeEventListener("input", clearError);
    };
    this.registerDomEvent(inputEl, "input", clearError);
  }
}

/**
 * Helper function to show a custom provider modal
 */
export function showCustomProviderModal(app: App, plugin: SystemSculptPlugin, options: Omit<CustomProviderModalOptions, 'onSave'>): Promise<CustomProvider | null> {
  return new Promise((resolve) => {
    const modal = new CustomProviderModal(app, plugin, {
      ...options,
      onSave: (provider) => {
        resolve(provider);
      },
      onCancel: () => {
        resolve(null);
      }
    });
    modal.open();
  });
} 
