import { App, Notice, SuggestModal, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import { launchAutomationProcessingModal } from "./AutomationProcessingModal";

export interface AutomationOption {
  id: string;
  title: string;
  subtitle?: string;
}

export class AutomationRunnerModal extends SuggestModal<AutomationOption> {
  private plugin: SystemSculptPlugin;
  private file: TFile;
  private options: AutomationOption[];

  constructor(app: App, plugin: SystemSculptPlugin, file: TFile, options: AutomationOption[]) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.options = options;
    this.setPlaceholder("Search automations...");
  }

  getSuggestions(query: string): AutomationOption[] {
    if (!query) {
      return this.options;
    }
    const lowered = query.toLowerCase();
    return this.options.filter((option) => option.title.toLowerCase().includes(lowered));
  }

  renderSuggestion(option: AutomationOption, el: HTMLElement): void {
    el.createEl("div", { text: option.title, cls: "ss-automation-suggestion-title" });
    if (option.subtitle) {
      el.createEl("small", { text: option.subtitle, cls: "ss-automation-suggestion-subtitle" });
    }
  }

  async onChooseSuggestion(option: AutomationOption): Promise<void> {
    // Close the selection modal so only the progress modal is visible
    this.close();

    const automationModal = launchAutomationProcessingModal({
      app: this.app,
      plugin: this.plugin,
      file: this.file,
      automationTitle: option.title,
    });

    try {
      const resultFile = await this.plugin.runAutomationOnFile(option.id, this.file, {
        onStatus: (status, progress) => {
          automationModal.setStatus(status, progress);
        },
      });
      if (resultFile) {
        automationModal.markSuccess({
          resultFile,
          openOutput: () => this.app.workspace.openLinkText(resultFile.path, "", true),
        });
      } else {
        automationModal.markFailure({
          error: `Automation finished but no note was created for ${this.file.basename}`,
        });
      }
    } catch (error) {
      automationModal.markFailure({ error });
    }
  }
}
