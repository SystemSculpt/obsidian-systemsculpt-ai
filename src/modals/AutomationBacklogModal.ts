import { App, Notice, Setting } from "obsidian";
import type SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { createUiAction, createUiState, updateUiAction } from "../core/ui/surface";
import { AutomationRunnerModal } from "./AutomationRunnerModal";
import type { AutomationBacklogEntry } from "../services/workflow/WorkflowEngineService";
import { WORKFLOW_AUTOMATIONS } from "../constants/workflowAutomations";

export class AutomationBacklogModal extends StandardModal {
  private plugin: SystemSculptPlugin;
  private backlog: AutomationBacklogEntry[] = [];

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app);
    this.plugin = plugin;
    this.setSize("large");
    this.modalEl.addClass("ss-automation-backlog-modal");
  }

  async onOpen(): Promise<void> {
    super.onOpen();
    this.addTitle("Automation backlog");
    this.addActionButton("Close", () => this.close());
    await this.refreshBacklog();
  }

  private async refreshBacklog(): Promise<void> {
    const task = this.beginAsyncTask("automation-backlog");
    this.renderLoadState("loading");
    try {
      const backlog = await this.plugin.getAutomationBacklog();
      if (!task.isCurrent()) return;
      this.backlog = backlog;
      this.render();
    } catch (error) {
      if (!task.isCurrent()) return;
      this.backlog = [];
      this.renderLoadState("error", error);
    }
  }

  private renderLoadState(kind: "loading" | "error", error?: unknown): void {
    this.contentEl.empty();
    this.contentEl.addClass("ss-automation-backlog");
    this.contentEl.setAttr("aria-busy", kind === "loading" ? "true" : "false");
    createUiState(this.contentEl, kind === "loading"
      ? {
          kind: "loading",
          title: "Loading backlog",
        }
      : {
          kind: "error",
          title: "Could not load the backlog",
          detail: error instanceof Error ? error.message : "Try loading it again.",
          action: {
            label: "Retry",
            onSelect: () => void this.refreshBacklog(),
          },
        });
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ss-automation-backlog");
    contentEl.setAttr("aria-busy", "false");

    this.renderControls();
    this.renderBacklogList();
  }

  private renderControls(): void {
    const controls = this.contentEl.createDiv({ cls: "ss-automation-backlog__controls" });
    const processAllButton = createUiAction(controls, {
      label: "Process backlog",
      tone: "primary",
      disabled: this.backlog.length === 0,
    });
    this.registerDomEvent(processAllButton, "click", async () => {
      if (this.backlog.length === 0) {
        new Notice("Nothing to process.");
        return;
      }
      updateUiAction(processAllButton, { busy: true, disabled: true });
      await this.processEntries(this.backlog);
      new Notice("Backlog processed");
      await this.refreshBacklog();
    });

    const runModalButton = createUiAction(controls, {
      label: "Run single automation",
    });
    this.registerDomEvent(runModalButton, "click", () => {
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
    });
  }

  private renderBacklogList(): void {
    const container = this.contentEl.createDiv({ cls: "ss-automation-backlog__list" });

    if (this.backlog.length === 0) {
      createUiState(container, {
        kind: "success",
        title: "Inbox clear",
        detail: "No files are waiting.",
      });
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
              await this.refreshBacklog();
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
