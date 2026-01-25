import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import { AutomationRunnerModal } from "./AutomationRunnerModal";
import { StandardModelSelectionModal, ModelSelectionResult } from "./StandardModelSelectionModal";
import { ensureCanonicalId } from "../utils/modelUtils";
import type { AutomationBacklogEntry } from "../services/workflow/WorkflowEngineService";
import { WORKFLOW_AUTOMATIONS } from "../constants/workflowTemplates";

export class AutomationBacklogModal extends Modal {
  private plugin: SystemSculptPlugin;
  private backlog: AutomationBacklogEntry[] = [];
  private contentWrapper: HTMLElement | null = null;

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app);
    this.plugin = plugin;
    this.setTitle("Automation Backlog");
  }

  async onOpen(): Promise<void> {
    await this.loadBacklog();
    this.render();
  }

  private async loadBacklog(): Promise<void> {
    this.backlog = await this.plugin.getAutomationBacklog();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.contentWrapper = contentEl.createDiv({ cls: "ss-automation-backlog" });

    this.renderModelSetting();
    this.renderControls();
    this.renderBacklogList();
  }

  private renderModelSetting(): void {
    new Setting(this.contentEl)
      .setName("Model")
      .setDesc(this.plugin.settings.selectedModelId || "Select a model")
      .addButton((button) => {
        button.setButtonText("Change model");
        button.onClick(() => {
          const modal = new StandardModelSelectionModal({
            app: this.app,
            plugin: this.plugin,
            currentModelId: this.plugin.settings.selectedModelId,
            onSelect: async (result: ModelSelectionResult) => {
              const canonicalId = ensureCanonicalId(result.modelId);
              await this.plugin.getSettingsManager().updateSettings({ selectedModelId: canonicalId });
              this.render();
            },
          });
          modal.open();
        });
      });
  }

  private renderControls(): void {
    const controls = this.contentEl.createDiv({ cls: "ss-automation-backlog__controls" });
    const processAllButton = controls.createEl("button", { text: "Process backlog" });
    processAllButton.addClass("mod-cta");
    processAllButton.disabled = this.backlog.length === 0;
    processAllButton.onclick = async () => {
      if (this.backlog.length === 0) {
        new Notice("Nothing to process.");
        return;
      }
      await this.processEntries(this.backlog);
      new Notice("Backlog processed");
      await this.loadBacklog();
      this.render();
    };

    const runModalButton = controls.createEl("button", { text: "Run single automation" });
    runModalButton.onclick = () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) {
        new Notice("Open a note to run an automation manually.");
        return;
      }
      const options = WORKFLOW_AUTOMATIONS.map((definition) => ({
        id: definition.id,
        title: definition.title,
        subtitle: definition.destinationPlaceholder,
      }));
      const runner = new AutomationRunnerModal(this.app, this.plugin, file, options);
      runner.open();
    };
  }

  private renderBacklogList(): void {
    const container = this.contentEl.createDiv({ cls: "ss-automation-backlog__list" });

    if (this.backlog.length === 0) {
      container.createEl("p", { text: "Inbox clear! No files are waiting." });
      return;
    }

    const grouped = this.groupBacklogByAutomation();
    grouped.forEach((entries, automationTitle) => {
      container.createEl("h4", { text: automationTitle });
      entries.forEach((entry) => {
        const row = new Setting(container)
          .setName(entry.file.basename)
          .setDesc(entry.file.path)
          .addButton((button) => {
            button.setButtonText("Open");
            button.onClick(() => {
              void this.app.workspace.openLinkText(entry.file.path, "");
            });
          })
          .addButton((button) => {
            button.setButtonText("Process");
            button.setCta();
            button.onClick(async () => {
              await this.processEntries([entry]);
              await this.loadBacklog();
              this.render();
            });
          });
        row.settingEl.addClass("ss-automation-backlog__row");
      });
    });
  }

  private groupBacklogByAutomation(): Map<string, AutomationBacklogEntry[]> {
    const map = new Map<string, AutomationBacklogEntry[]>();
    for (const entry of this.backlog) {
      const existing = map.get(entry.automationTitle) || [];
      existing.push(entry);
      map.set(entry.automationTitle, existing);
    }
    return map;
  }

  private async processEntries(entries: AutomationBacklogEntry[]): Promise<void> {
    for (const entry of entries) {
      try {
        await this.plugin.runAutomationOnFile(entry.automationId, entry.file);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Failed to process ${entry.file.basename}: ${message}`, 6000);
      }
    }
  }
}
