import { Notice, Setting } from "obsidian";
import { ListSelectionModal, type ListItem } from "../core/ui/modals/standard/ListSelectionModal";
import { attachFolderSuggester } from "../components/FolderSuggester";
import type { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { ReplicateImageService } from "../services/canvasflow/ReplicateImageService";
import {
  REPLICATE_PRICING_SNAPSHOT_DATE,
  formatCuratedModelOptionText,
  getCuratedReplicateModelGroups,
} from "../services/canvasflow/ReplicateModelCatalog";

export async function displayImageGenerationTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "image-generation";
  }

  const { plugin } = tabInstance;

  containerEl.createEl("h3", { text: "Image Generation" });
  containerEl.createEl("p", {
    text: "Configure Replicate and enable SystemSculpt Canvas (experimental) to run ComfyUI-like image graphs inside Obsidian Canvas.",
    cls: "setting-item-description",
  });

  new Setting(containerEl)
    .setName("Enable SystemSculpt Canvas enhancements (experimental)")
    .setDesc(
      "Adds SystemSculpt canvas action buttons to the Canvas selection toolbar and injects prompt controls into SystemSculpt prompt nodes. Desktop-only. Expect breakage after Obsidian updates."
    )
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.canvasFlowEnabled === true)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ canvasFlowEnabled: value });
          new Notice(value ? "SystemSculpt canvas enhancements enabled." : "SystemSculpt canvas enhancements disabled.");
        });
    });

  containerEl.createEl("h3", { text: "Replicate" });

  new Setting(containerEl)
    .setName("Replicate API key")
    .setDesc("Required to search models and generate images via Replicate.")
    .addText((text) => {
      text
        .setPlaceholder("r8_...")
        .setValue(plugin.settings.replicateApiKey || "")
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ replicateApiKey: value });
        });
      text.inputEl.type = "password";
    });

  const modelSetting = new Setting(containerEl)
    .setName("Default image model")
    .setDesc("Used when a SystemSculpt prompt node doesn't specify ss_replicate_model. Use the browser button to pick a model.");

  modelSetting.addText((text) => {
    text
      .setPlaceholder("Example: stability-ai/sdxl")
      .setValue(plugin.settings.replicateDefaultModelSlug || "")
      .onChange(async (value) => {
        await plugin.getSettingsManager().updateSettings({
          replicateDefaultModelSlug: value.trim(),
          // Clear resolved version when slug changes; user can re-resolve.
          replicateResolvedVersion:
            value.trim() !== (plugin.settings.replicateDefaultModelSlug || "").trim()
              ? ""
              : plugin.settings.replicateResolvedVersion,
        });
      });
  });

  modelSetting.addExtraButton((button) => {
    button
      .setIcon("search")
      .setTooltip("Browse Replicate models")
      .onClick(async () => {
        await openReplicateModelBrowser(tabInstance);
      });
  });

  modelSetting.addExtraButton((button) => {
    button
      .setIcon("refresh-cw")
      .setTooltip("Resolve latest version for the default model")
      .onClick(async () => {
        button.setDisabled(true);
        try {
          await resolveDefaultModelVersion(tabInstance);
        } finally {
          button.setDisabled(false);
        }
      });
  });

  const versionSetting = new Setting(containerEl)
    .setName("Resolved model version")
    .setDesc("Pinned Replicate version id used when your prompt file doesn't specify ss_replicate_version.");

  const versionValue = versionSetting.controlEl.createEl("code", {
    text: plugin.settings.replicateResolvedVersion?.trim() ? plugin.settings.replicateResolvedVersion.trim() : "(not set)",
  });
  versionValue.addClass("systemsculpt-inline-code");

  new Setting(containerEl)
    .setName("Output folder")
    .setDesc("Vault folder where generated images will be saved.")
    .addText((text) => {
      text
        .setPlaceholder("SystemSculpt/Attachments/Generations")
        .setValue(plugin.settings.replicateOutputDir || "")
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ replicateOutputDir: value.trim() });
        });
      attachFolderSuggester(text.inputEl, (value) => text.setValue(value), tabInstance.app);
    });

  new Setting(containerEl)
    .setName("Prediction poll interval (ms)")
    .setDesc("How often SystemSculpt canvas generation checks Replicate for status updates.")
    .addText((text) => {
      text
        .setPlaceholder("1000")
        .setValue(String(plugin.settings.replicatePollIntervalMs ?? 1000))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            return;
          }
          await plugin.getSettingsManager().updateSettings({ replicatePollIntervalMs: parsed });
        });
      text.inputEl.inputMode = "numeric";
    });

  new Setting(containerEl)
    .setName("Write metadata sidecar")
    .setDesc("When enabled, writes a JSON file next to each generated image with prompt, model, and prediction metadata.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.replicateSaveMetadataSidecar !== false)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ replicateSaveMetadataSidecar: value });
        });
    });

  new Setting(containerEl)
    .setName("Test Replicate connection")
    .setDesc("Validates your API key and default model by resolving the latest version.")
    .addButton((button) => {
      button.setButtonText("Test").onClick(async () => {
        button.setDisabled(true);
        try {
          await resolveDefaultModelVersion(tabInstance);
          new Notice("Replicate connection OK.");
        } catch (error: any) {
          new Notice(`Replicate test failed: ${error?.message || error}`);
        } finally {
          button.setDisabled(false);
        }
      });
    });
}

async function resolveDefaultModelVersion(tabInstance: SystemSculptSettingTab): Promise<void> {
  const { plugin } = tabInstance;
  const key = String(plugin.settings.replicateApiKey || "").trim();
  if (!key) {
    new Notice("Set your Replicate API key first.");
    return;
  }

  const slug = String(plugin.settings.replicateDefaultModelSlug || "").trim();
  if (!slug) {
    new Notice("Pick a default Replicate model first.");
    return;
  }

  const service = new ReplicateImageService(key);
  const details = await service.resolveLatestVersion(slug);
  await plugin.getSettingsManager().updateSettings({
    replicateDefaultModelSlug: details.slug,
    replicateResolvedVersion: details.latestVersionId,
  });
  new Notice("Resolved latest Replicate version.");
  tabInstance.display();
}

async function openReplicateModelBrowser(tabInstance: SystemSculptSettingTab): Promise<void> {
  const { plugin } = tabInstance;
  const currentDefault = String(plugin.settings.replicateDefaultModelSlug || "").trim();
  const groups = getCuratedReplicateModelGroups();
  const items: ListItem[] = [];
  for (const g of groups) {
    for (const model of g.models) {
      items.push({
        id: model.slug,
        title: formatCuratedModelOptionText(model),
        description: model.pricing.lines.join(" | "),
        icon: "image",
        badge: model.pricing.summary,
        selected: model.slug === currentDefault,
        metadata: { slug: model.slug, provider: g.provider },
      });
    }
  }

  const modal = new ListSelectionModal(tabInstance.app, items, {
    title: "Replicate models (curated)",
    description: `Newest-gen image models. Prices are snapshots from replicate.com as of ${REPLICATE_PRICING_SNAPSHOT_DATE}.`,
    withSearch: true,
    size: "large",
    customContent: (containerEl) => {
      const hint = containerEl.createEl("p", {
        text: "Pick a model for SystemSculpt canvas prompts. The dropdown in prompt nodes uses the same curated list.",
        cls: "setting-item-description",
      });
      hint.style.marginTop = "0";
    },
  });

  const [selection] = await modal.openAndGetSelection();
  const slug = String(selection?.metadata?.slug || "").trim();
  if (!slug) {
    return;
  }

  // Always set the slug immediately; version resolution is best-effort.
  await plugin.getSettingsManager().updateSettings({
    replicateDefaultModelSlug: slug,
    replicateResolvedVersion: "",
  });

  const key = String(plugin.settings.replicateApiKey || "").trim();
  if (key) {
    try {
      const service = new ReplicateImageService(key);
      const details = await service.resolveLatestVersion(slug);
      await plugin.getSettingsManager().updateSettings({
        replicateDefaultModelSlug: details.slug,
        replicateResolvedVersion: details.latestVersionId,
      });
      new Notice(`Default Replicate model set to ${details.slug}`);
      tabInstance.display();
      return;
    } catch (error: any) {
      new Notice(`Set default model to ${slug}, but failed to resolve version: ${error?.message || error}`);
      tabInstance.display();
      return;
    }
  }

  new Notice(`Default Replicate model set to ${slug}.`);
  tabInstance.display();
}
