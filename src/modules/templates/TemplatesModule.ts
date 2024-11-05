import { MarkdownView, requestUrl, Setting, TFolder, TFile } from "obsidian";
import SystemSculptPlugin from "../../main";
import { AIService } from "../../api/AIService";
import { showCustomNotice } from "../../modals";
import { TemplatesSuggest, FrontMatter } from "./TemplatesSuggest";
import { checkLicenseValidity } from "./functions/checkLicenseValidity";
import { IGenerationModule } from "../../interfaces/IGenerationModule";
import { BlankTemplateModal } from "./views/BlankTemplateModal";
import { MultiSuggest } from "../../utils/MultiSuggest";
import { renderLicenseKeySetting } from "./settings/LicenseKeySetting";
import { logModuleLoadTime } from "../../utils/timing";

export interface TemplatesSettings {
  templatesPath: string;
  blankTemplatePrompt: string;
  licenseKey: string;
  templatesVersion: string;
  showSSSyncTemplates: boolean;
  triggerKey: string;
  isPatreonMember: boolean;
  copyResponseToClipboard: boolean;
  rememberSelectedTemplate: boolean;
  lastSelectedTemplate: string;
}

export const DEFAULT_TEMPLATES_SETTINGS: TemplatesSettings = {
  templatesPath: "SystemSculpt/Templates",
  blankTemplatePrompt: `You are an AI assistant tasked with generating concise and specific content based on the user's prompt. Your role is to provide a focused and useful response without unnecessary prose.
  
Rules:
- Carefully analyze the user's prompt to understand their intent and desired output.
- Generate content that directly addresses the prompt, avoiding tangents or filler text.
- Aim to provide a succinct and actionable response that meets the user's needs.
- Ensure your output is well-structured, clear, and easy to follow.
- Do not introduce any new formatting or markdown syntax unless specifically requested in the prompt.
- Your generation response should be purely the requested content, without any additional labels or explanations.`,
  licenseKey: "",
  templatesVersion: "0.0.1",
  showSSSyncTemplates: true,
  triggerKey: "/",
  isPatreonMember: false,
  copyResponseToClipboard: false,
  rememberSelectedTemplate: false,
  lastSelectedTemplate: "",
};

export class TemplatesModule implements IGenerationModule {
  plugin: SystemSculptPlugin;
  settings: TemplatesSettings;
  private _AIService: AIService | null = null;
  abortController: AbortController | null = null;
  isGenerationCompleted: boolean = false;
  private firstLicenseCheckDone: boolean = false;
  private _templateSuggest: TemplatesSuggest | null = null;
  private templateCache: Map<string, any> = new Map();

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.settings = DEFAULT_TEMPLATES_SETTINGS;
  }

  get AIService(): AIService {
    if (!this._AIService) {
      this._AIService = this.plugin.brainModule.AIService;
    }
    return this._AIService as AIService;
  }

  get templateSuggest() {
    if (!this._templateSuggest) {
      this._templateSuggest = new TemplatesSuggest(this, this.templateCache);
    }
    return this._templateSuggest;
  }

  async load() {
    const startTime = performance.now();

    // Only load settings initially
    await this.loadSettings();

    // Register commands immediately
    this.addCommands();

    // Defer heavy operations
    queueMicrotask(async () => {
      await this.initializeTemplates();
      this.registerCodeMirror();
      this.registerDomEvent();
      await this.checkLicenseOnStartup();
    });

    logModuleLoadTime("Templates", startTime);
  }

  async loadSettings() {
    const savedSettings = await this.plugin.loadData();
    this.settings = Object.assign(
      {},
      DEFAULT_TEMPLATES_SETTINGS,
      savedSettings
    );
  }

  async saveSettings() {
    await this.plugin.saveSettings(this.settings);
  }

  registerCodeMirror() {
    this.plugin.registerEditorSuggest(this.templateSuggest);
  }

  registerDomEvent() {
    if (this.settings.triggerKey) {
      this.plugin.registerDomEvent(
        document,
        "keydown",
        (evt: KeyboardEvent) => {
          if (evt.key === this.settings.triggerKey) {
            const activeView =
              this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
            if (activeView) {
              const editor = activeView.editor;
              const selectedText = editor.getSelection();
              if (selectedText) {
                evt.preventDefault();
                new BlankTemplateModal(this).open();
              }
            }
          }
        }
      );
    }
  }

  stopGeneration(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.isGenerationCompleted = false;
      showCustomNotice("Template generation stopped", 5000);
    }
  }

  async checkLicenseOnStartup(): Promise<void> {
    if (this.firstLicenseCheckDone) return;

    const licenseKey = this.settings.licenseKey;
    if (!licenseKey || !licenseKey.includes("-") || licenseKey.includes(" ")) {
      return;
    }

    if (await checkLicenseValidity(this)) {
      await this.checkAndUpdateTemplates();
    }
    this.firstLicenseCheckDone = true;
  }

  async checkForUpdate(): Promise<void> {
    if (!this.settings.licenseKey || this.settings.licenseKey.trim() === "") {
      return;
    }
    if (await checkLicenseValidity(this)) {
      await this.checkAndUpdateTemplates();
    }
  }

  async checkAndUpdateTemplates(): Promise<void> {
    if (!this.settings.isPatreonMember) {
      return;
    }

    if (!this.settings.licenseKey || this.settings.licenseKey.trim() === "") {
      return;
    }

    const serverVersionResponse = await requestUrl({
      url: "https://license.systemsculpt.com/templates-version",
    });

    const serverVersion = serverVersionResponse.json.version;

    if (this.settings.templatesVersion !== serverVersion) {
      showCustomNotice(
        "A new version of the templates is available. Please update manually through the settings."
      );
    }
  }

  async triggerTemplateSuggestions(): Promise<void> {
    const activeView =
      this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      const editor = activeView.editor;
      const selectedText = editor.getSelection();
      if (selectedText) {
        new BlankTemplateModal(this).open();
      }
    }
  }

  settingsDisplay(containerEl: HTMLElement): void {
    containerEl.empty();

    new Setting(containerEl).setName("Templates").setHeading();
    containerEl.createEl("p", {
      text: "Change your default AI templates location, what your default blank prompt does in the background, and more.",
    });

    const patreonSetting = new Setting(containerEl)
      .setName("Are you a Patreon member?")
      .setDesc("Toggle to show Patreon member options")
      .addToggle((toggle) => {
        toggle
          .setValue(this.settings.isPatreonMember)
          .onChange(async (value: boolean) => {
            this.settings.isPatreonMember = value;
            await this.saveSettings();
            this.settingsDisplay(containerEl);
          });
      });

    patreonSetting.settingEl.addClass("systemsculpt-patreon-member-setting");

    if (this.settings.isPatreonMember) {
      const infoBoxEl = containerEl.createDiv("systemsculpt-info-box");
      infoBoxEl.createEl("p", {
        text: "If you're a Patreon member, download the latest AI templates from SystemSculpt!",
      });

      infoBoxEl.addClass("systemsculpt-patreon-sub-setting");

      this.renderLicenseKeySetting(containerEl);

      const ssSyncSetting = new Setting(containerEl)
        .setName("Show SS-Sync templates in suggestions")
        .setDesc("Toggle the display of templates within the SS-Sync folder")
        .addToggle((toggle) => {
          toggle
            .setValue(this.settings.showSSSyncTemplates)
            .onChange(async (value: boolean) => {
              this.settings.showSSSyncTemplates = value;
              await this.saveSettings();
            });

          const keepInMindBoxEl = containerEl.createDiv(
            "systemsculpt-info-box"
          );
          keepInMindBoxEl.createEl("p", {
            text: "Whenever you sync to the latest templates, all templates found in the SS-Sync folder will be overwritten. This means that if you want to modify one to your own liking, make sure to place it in the Templates folder, outside of the SS-Sync directory - it will be safe there and won't be overwritten.",
          });

          keepInMindBoxEl.addClass("systemsculpt-patreon-sub-setting");
        });

      ssSyncSetting.settingEl.addClass("systemsculpt-patreon-sub-setting");
    } else {
      const becomePatreonEl = containerEl.createDiv("systemsculpt-info-box");
      const becomePatreonButton = becomePatreonEl.createEl("button", {
        cls: "",
        text: "Click here to become a Patreon member for only $10 bucks!",
      });
      becomePatreonButton.addEventListener("click", () => {
        window.open("https://patreon.com/systemsculpt", "_blank");
      });
    }

    this.renderTriggerKeySetting(containerEl);
    this.renderTemplatesPathSetting(containerEl);
    this.renderBlankTemplatePromptSetting(containerEl);
    this.renderRememberSelectedTemplateSetting(containerEl);
    this.renderCopyToClipboardSetting(containerEl);
  }

  private renderLicenseKeySetting(containerEl: HTMLElement): void {
    renderLicenseKeySetting(containerEl, this);
  }

  private renderTriggerKeySetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Trigger key")
      .setDesc(
        "The key that triggers the template suggestion modal (single character only, leave empty to disable)"
      )
      .addText((text) => {
        text
          .setPlaceholder("Enter trigger key or leave empty")
          .setValue(this.settings.triggerKey);

        text.inputEl.addEventListener(
          "keydown",
          async (event: KeyboardEvent) => {
            event.preventDefault();
            const triggerKey = event.key.length === 1 ? event.key : "";
            this.settings.triggerKey = triggerKey;
            await this.saveSettings();
            text.setValue(triggerKey);
            this.registerDomEvent();
          }
        );
      })
      .addExtraButton((button) => {
        button
          .setIcon("reset")
          .setTooltip("Reset to default trigger key")
          .onClick(async () => {
            this.settings.triggerKey = "/";
            await this.saveSettings();
            this.settingsDisplay(containerEl);
            this.registerDomEvent();
          });
      });
  }

  private renderTemplatesPathSetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Templates folder location")
      .setDesc("Path where the templates will be stored")
      .addText((text) => {
        text
          .setPlaceholder("Enter path")
          .setValue(this.settings.templatesPath)
          .onChange(async (value) => {
            this.settings.templatesPath = value;
            await this.saveSettings();
          });

        const inputEl = text.inputEl;
        const suggestionContent = this.getFolderSuggestions();
        const onSelectCallback = (selectedPath: string) => {
          this.settings.templatesPath = selectedPath;
          text.setValue(selectedPath);
          this.saveSettings();
        };

        new MultiSuggest(
          inputEl,
          suggestionContent,
          onSelectCallback,
          this.plugin.app
        );
      })
      .addExtraButton((button) => {
        button
          .setIcon("reset")
          .setTooltip("Reset to default path")
          .onClick(async () => {
            this.settings.templatesPath =
              DEFAULT_TEMPLATES_SETTINGS.templatesPath;
            await this.saveSettings();
            this.settingsDisplay(containerEl);
          });
      });
  }

  private getFolderSuggestions(): Set<string> {
    const folders = this.plugin.app.vault
      .getAllLoadedFiles()
      .filter((file) => file instanceof TFolder) as TFolder[];
    const suggestionContent = new Set(folders.map((folder) => folder.path));
    return suggestionContent;
  }

  private renderBlankTemplatePromptSetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Blank template prompt")
      .setDesc("The system prompt used for the Blank Template.")
      .addTextArea((text) => {
        text
          .setPlaceholder("Enter blank template prompt")
          .setValue(this.settings.blankTemplatePrompt)
          .onChange(async (newValue: string) => {
            this.settings.blankTemplatePrompt = newValue;
            await this.saveSettings();
          });
        text.inputEl.rows = 10;
        text.inputEl.cols = 50;
      })
      .addExtraButton((button) => {
        button
          .setIcon("reset")
          .setTooltip("Reset to default blank template prompt")
          .onClick(async () => {
            this.settings.blankTemplatePrompt =
              DEFAULT_TEMPLATES_SETTINGS.blankTemplatePrompt;
            await this.saveSettings();
            this.settingsDisplay(containerEl);
          });
      });
  }

  private renderRememberSelectedTemplateSetting(
    containerEl: HTMLElement
  ): void {
    new Setting(containerEl)
      .setName("Remember selected template")
      .setDesc(
        "Automatically use the last selected template for future generations"
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.settings.rememberSelectedTemplate)
          .onChange(async (value: boolean) => {
            this.settings.rememberSelectedTemplate = value;
            if (!value) {
              this.settings.lastSelectedTemplate = "";
            }
            await this.saveSettings();
          });
      });
  }

  private renderCopyToClipboardSetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Copy response to clipboard")
      .setDesc("Automatically copy the generated response to the clipboard")
      .addToggle((toggle) => {
        toggle
          .setValue(this.settings.copyResponseToClipboard)
          .onChange(async (value: boolean) => {
            this.settings.copyResponseToClipboard = value;
            await this.saveSettings();
          });
      });
  }

  public openBlankTemplateModal(): void {
    const activeView =
      this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      new BlankTemplateModal(this).open();
    } else {
      showCustomNotice(
        "Please open a note before using the Blank Template Modal.",
        3000
      );
    }
  }

  private async initializeTemplates() {
    // Pre-cache templates in background
    const templateFiles = await this.getTemplateFiles();
    for (const file of templateFiles) {
      const frontMatter = await this.parseFrontMatter(file);
      this.templateCache.set(file.path, frontMatter);
    }
  }

  private addCommands() {
    this.plugin.addCommand({
      id: "trigger-template-suggestions",
      name: "Trigger template suggestions",
      callback: () => this.triggerTemplateSuggestions(),
    });

    this.plugin.addCommand({
      id: "open-blank-template-modal",
      name: "Open Blank Template Modal",
      callback: () => this.openBlankTemplateModal(),
      hotkeys: [],
    });
  }

  private async getTemplateFiles(): Promise<TFile[]> {
    const templatesPath = this.settings.templatesPath;
    const folder = this.plugin.app.vault.getAbstractFileByPath(templatesPath);

    if (!(folder instanceof TFolder)) {
      return [];
    }

    const files: TFile[] = [];
    const collectFiles = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFile && child.extension === "md") {
          files.push(child);
        } else if (child instanceof TFolder) {
          collectFiles(child);
        }
      }
    };

    collectFiles(folder);
    return files;
  }

  private async parseFrontMatter(file: TFile): Promise<FrontMatter> {
    const cached = this.templateCache.get(file.path);
    if (cached) return cached;

    const content = await this.plugin.app.vault.read(file);
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const frontMatter = cache?.frontmatter;

    if (frontMatter) {
      const result = {
        name: frontMatter.name || "",
        description: frontMatter.description || "",
        model: frontMatter.model || "default",
        maxOutputTokens:
          frontMatter["max tokens"] ||
          frontMatter["max_tokens"] ||
          frontMatter["max output tokens"] ||
          frontMatter["max_output_tokens"] ||
          undefined,
        tags:
          typeof frontMatter.tags === "string"
            ? frontMatter.tags.split(",").map((tag: string) => tag.trim())
            : Array.isArray(frontMatter.tags)
              ? frontMatter.tags
              : [],
        prompt: content,
      };
      this.templateCache.set(file.path, result);
      return result;
    }

    return {
      name: "",
      description: "",
      model: "default",
      maxOutputTokens: undefined,
      tags: [],
      prompt: content,
    };
  }
}
