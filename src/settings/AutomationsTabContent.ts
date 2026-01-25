import { App, Notice, Setting, setIcon } from "obsidian";
import { attachFolderSuggester } from "../components/FolderSuggester";
import { WORKFLOW_AUTOMATIONS, WorkflowAutomationDefinition } from "../constants/workflowTemplates";
import type { WorkflowEngineSettings, WorkflowAutomationState } from "../types";
import { createDefaultWorkflowEngineSettings } from "../types";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";

interface AutomationCardContext {
  app: App;
  getWorkflowSettings: () => WorkflowEngineSettings;
  updateAutomation: (id: string, updates: Partial<WorkflowAutomationState>) => Promise<void>;
}

export function displayAutomationsTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab): void {
  containerEl.empty();
  containerEl.addClass("systemsculpt-tab-content");
  containerEl.dataset.tab = "automations";

  const { plugin } = tabInstance;
  const settingsManager = plugin.getSettingsManager();

  const getWorkflowSettings = (): WorkflowEngineSettings => {
    return plugin.settings.workflowEngine ?? createDefaultWorkflowEngineSettings();
  };

  const updateWorkflowEngine = async (
    mutator: (current: WorkflowEngineSettings) => WorkflowEngineSettings
  ): Promise<void> => {
    const updated = mutator(getWorkflowSettings());
    await settingsManager.updateSettings({ workflowEngine: updated });
  };

  const updateAutomation = async (
    automationId: string,
    updates: Partial<WorkflowAutomationState>
  ): Promise<void> => {
    await updateWorkflowEngine((current) => {
      const existing = current.templates?.[automationId] || { id: automationId, enabled: false };
      return {
        ...current,
        templates: {
          ...current.templates,
          [automationId]: {
            ...existing,
            ...updates,
            id: automationId,
          },
        },
      };
    });
  };

  containerEl.createEl("h3", { text: "Automations" });
  containerEl.createEl("p", {
    text: "Toggle the workflows you want. Adjust capture/destination folders if your Daily Vault layout differs.",
    cls: "setting-item-description",
  });

  const cardsWrapper = containerEl.createDiv({ cls: "ss-automations-gallery" });
  const cardContext: AutomationCardContext = {
    app: tabInstance.app,
    getWorkflowSettings,
    updateAutomation,
  };

  WORKFLOW_AUTOMATIONS.forEach((automation) => {
    renderAutomationCard(automation, cardsWrapper, cardContext);
  });

  containerEl.createEl("p", {
    text: "Tip: Use the command palette → “Run Workflow Automation” to manually process the active note with any enabled automation.",
    cls: "setting-item-description",
  });

  const skippedCount = Object.keys(getWorkflowSettings().skippedFiles ?? {}).length;
  const skippedSetting = new Setting(containerEl)
    .setName("Skipped workflow items")
    .setDesc(
      skippedCount > 0
        ? `${skippedCount} file${skippedCount > 1 ? "s" : ""} are marked as skipped.`
        : "No skipped workflow items."
    );

  if (skippedCount > 0) {
    skippedSetting.addButton((button) => {
      button.setButtonText("Clear skip list").setWarning();
      button.onClick(async () => {
        await updateWorkflowEngine((current) => ({
          ...current,
          skippedFiles: {},
        }));
        new Notice("Cleared skipped workflow items.", 4000);
        displayAutomationsTabContent(containerEl, tabInstance);
      });
    });
  }
}

function renderAutomationCard(
  automation: WorkflowAutomationDefinition,
  parent: HTMLElement,
  context: AutomationCardContext
): void {
  const { getWorkflowSettings, updateAutomation, app } = context;
  const card = parent.createDiv({ cls: "ss-automation-card" });

  const header = card.createDiv({ cls: "ss-automation-card__header" });
  const iconHolder = header.createDiv({ cls: "ss-automation-card__icon" });
  setIcon(iconHolder, automation.icon);
  const titleWrapper = header.createDiv({ cls: "ss-automation-card__title" });
  titleWrapper.createSpan({ text: "Automation", cls: "ss-automation-card__badge" });
  titleWrapper.createEl("strong", { text: automation.title });

  card.createEl("p", { text: automation.subtitle, cls: "ss-automation-card__subtitle" });
  card.createEl("p", { text: automation.description, cls: "ss-automation-card__description" });

  const state = getWorkflowSettings().templates?.[automation.id];

  renderFolderSetting(
    card,
    "Capture from",
    "Folder the workflow watches",
    state?.sourceFolder || automation.capturePlaceholder || "10 - capture-intake/Inbox",
    automation.capturePlaceholder,
    app,
    async (value) => updateAutomation(automation.id, { sourceFolder: value })
  );

  renderFolderSetting(
    card,
    "Route to",
    "Where processed notes should live",
    state?.destinationFolder || automation.destinationPlaceholder || "40 - areas",
    automation.destinationPlaceholder,
    app,
    async (value) => updateAutomation(automation.id, { destinationFolder: value })
  );

  new Setting(card)
    .setName("Enable automation")
    .setDesc("Watch the capture folder and run automatically")
    .addToggle((toggle) => {
      toggle.setValue(state?.enabled ?? false);
      toggle.onChange(async (value) => {
        await updateAutomation(automation.id, { enabled: value });
      });
    });
}

function renderFolderSetting(
  containerEl: HTMLElement,
  name: string,
  description: string,
  value: string,
  placeholder: string | undefined,
  app: App,
  onChange: (value: string) => Promise<void>
): void {
  new Setting(containerEl)
    .setName(name)
    .setDesc(description)
    .addText((text) => {
      text.setPlaceholder(placeholder || "10 - capture-intake/Inbox");
      text.setValue(value || "");
      text.onChange(async (newValue) => {
        await onChange(newValue);
      });
      attachFolderSuggester(text.inputEl, async (selected) => {
        text.setValue(selected);
        await onChange(selected);
      }, app);
    });
}
