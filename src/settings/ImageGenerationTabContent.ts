import { Notice, Setting } from "obsidian";
import { ListSelectionModal, type ListItem } from "../core/ui/modals/standard/ListSelectionModal";
import { attachFolderSuggester } from "../components/FolderSuggester";
import type { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import {
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  IMAGE_GENERATION_PRICING_SNAPSHOT_DATE,
  formatCuratedImageModelOptionText,
  getCuratedImageGenerationModelGroups,
  type ImageGenerationServerCatalogModel,
} from "../services/canvasflow/ImageGenerationModelCatalog";
import { SystemSculptImageGenerationService } from "../services/canvasflow/SystemSculptImageGenerationService";

export async function displayImageGenerationTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "image-generation";
  }

  const { plugin } = tabInstance;

  containerEl.createEl("h3", { text: "Image Generation" });
  containerEl.createEl("p", {
    text: "Configure SystemSculpt Canvas (experimental) and run image generation through the SystemSculpt API with OpenRouter providers.",
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

  containerEl.createEl("h3", { text: "SystemSculpt Image API (OpenRouter)" });

  const modelSetting = new Setting(containerEl)
    .setName("Default image model")
    .setDesc("Used when a prompt node doesn't specify ss_image_model. The default is a low-cost OpenAI image model for testing.");

  modelSetting.addText((text) => {
    text
      .setPlaceholder(DEFAULT_IMAGE_GENERATION_MODEL_ID)
      .setValue(plugin.settings.imageGenerationDefaultModelId || DEFAULT_IMAGE_GENERATION_MODEL_ID)
      .onChange(async (value) => {
        const trimmed = value.trim();
        await plugin
          .getSettingsManager()
          .updateSettings({ imageGenerationDefaultModelId: trimmed || DEFAULT_IMAGE_GENERATION_MODEL_ID });
      });
  });

  modelSetting.addExtraButton((button) => {
    button
      .setIcon("search")
      .setTooltip("Browse image models")
      .onClick(async () => {
        await openImageModelBrowser(tabInstance);
      });
  });

  new Setting(containerEl)
    .setName("Output folder")
    .setDesc("Vault folder where generated images will be saved (safely scoped under SystemSculpt/Attachments/Generations).")
    .addText((text) => {
      text
        .setPlaceholder("SystemSculpt/Attachments/Generations")
        .setValue(plugin.settings.imageGenerationOutputDir || "")
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ imageGenerationOutputDir: value.trim() });
        });
      attachFolderSuggester(text.inputEl, (value) => text.setValue(value), tabInstance.app);
    });

  new Setting(containerEl)
    .setName("Job poll interval (ms)")
    .setDesc("Base polling interval for image job status (adaptive backoff still applies).")
    .addText((text) => {
      text
        .setPlaceholder("1000 (250-10000)")
        .setValue(String(plugin.settings.imageGenerationPollIntervalMs ?? 1000))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) {
            return;
          }
          const next = Math.max(250, Math.min(10_000, parsed));
          await plugin.getSettingsManager().updateSettings({ imageGenerationPollIntervalMs: next });
        });
      text.inputEl.inputMode = "numeric";
    });

  new Setting(containerEl)
    .setName("Write metadata sidecar")
    .setDesc("When enabled, writes a JSON file next to each generated image with prompt, model, and job metadata.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.imageGenerationSaveMetadataSidecar !== false)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ imageGenerationSaveMetadataSidecar: value });
        });
    });

  new Setting(containerEl)
    .setName("Test image generation API")
    .setDesc("Validates your license and SystemSculpt image model access by listing available models.")
    .addButton((button) => {
      button.setButtonText("Test").onClick(async () => {
        button.setDisabled(true);
        try {
          await testImageGenerationConnection(tabInstance);
        } catch (error: any) {
          new Notice(`Image generation API test failed: ${error?.message || error}`);
        } finally {
          button.setDisabled(false);
        }
      });
    });
}

async function testImageGenerationConnection(tabInstance: SystemSculptSettingTab): Promise<void> {
  const { plugin } = tabInstance;
  const models = await syncImageGenerationModelCatalog(tabInstance);
  if (models.length === 0) {
    throw new Error("No image generation models were returned by the server.");
  }

  const configured = String(plugin.settings.imageGenerationDefaultModelId || "").trim();
  const fallback = models[0]?.id || DEFAULT_IMAGE_GENERATION_MODEL_ID;
  const nextModel = configured || fallback;

  await plugin.getSettingsManager().updateSettings({
    imageGenerationDefaultModelId: nextModel,
  });

  new Notice(`Image generation API connection OK (${models.length} model${models.length === 1 ? "" : "s"}).`);
  tabInstance.display();
}

async function openImageModelBrowser(tabInstance: SystemSculptSettingTab): Promise<void> {
  const { plugin } = tabInstance;
  const currentDefault = String(plugin.settings.imageGenerationDefaultModelId || "").trim();
  const serverModels = await syncImageGenerationModelCatalog(tabInstance, { silent: true });
  const groups = getCuratedImageGenerationModelGroups(serverModels);
  const items: ListItem[] = [];

  for (const group of groups) {
    for (const model of group.models) {
      items.push({
        id: model.id,
        title: formatCuratedImageModelOptionText(model),
        description: model.pricing.lines.join(" | "),
        icon: "image",
        badge: model.pricing.summary,
        selected: model.id === currentDefault,
        metadata: { id: model.id, provider: group.provider },
      });
    }
  }

  const modal = new ListSelectionModal(tabInstance.app, items, {
    title: "Image models",
    description: `Merged from live SystemSculpt API catalog and curated defaults. Curated cost estimates are as of ${IMAGE_GENERATION_PRICING_SNAPSHOT_DATE}.`,
    withSearch: true,
    size: "large",
    customContent: (el) => {
      const hint = el.createEl("p", {
        text: "Pick a default model for CanvasFlow prompt nodes.",
        cls: "setting-item-description",
      });
      hint.style.marginTop = "0";
    },
  });

  const [selection] = await modal.openAndGetSelection();
  const modelId = String(selection?.metadata?.id || "").trim();
  if (!modelId) {
    return;
  }

  await plugin.getSettingsManager().updateSettings({
    imageGenerationDefaultModelId: modelId,
  });

  new Notice(`Default image model set to ${modelId}.`);
  tabInstance.display();
}

function getCachedServerImageModels(tabInstance: SystemSculptSettingTab): ImageGenerationServerCatalogModel[] {
  const models = tabInstance.plugin.settings.imageGenerationModelCatalogCache?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((model) => ({
      id: String((model as any)?.id || "").trim(),
      name: String((model as any)?.name || "").trim() || undefined,
      provider: String((model as any)?.provider || "").trim() || undefined,
      input_modalities: Array.isArray((model as any)?.input_modalities)
        ? (model as any).input_modalities.map((value: unknown) => String(value || ""))
        : undefined,
      output_modalities: Array.isArray((model as any)?.output_modalities)
        ? (model as any).output_modalities.map((value: unknown) => String(value || ""))
        : undefined,
      supports_image_input:
        typeof (model as any)?.supports_image_input === "boolean"
          ? (model as any).supports_image_input
          : undefined,
      max_images_per_job:
        typeof (model as any)?.max_images_per_job === "number" && Number.isFinite((model as any).max_images_per_job)
          ? Math.max(1, Math.floor((model as any).max_images_per_job))
          : undefined,
      default_aspect_ratio: String((model as any)?.default_aspect_ratio || "").trim() || undefined,
      allowed_aspect_ratios: Array.isArray((model as any)?.allowed_aspect_ratios)
        ? (model as any).allowed_aspect_ratios.map((value: unknown) => String(value || ""))
        : undefined,
    }))
    .filter((model) => model.id.length > 0);
}

async function syncImageGenerationModelCatalog(
  tabInstance: SystemSculptSettingTab,
  options?: { silent?: boolean }
): Promise<ImageGenerationServerCatalogModel[]> {
  const { plugin } = tabInstance;
  const licenseKey = String(plugin.settings.licenseKey || "").trim();
  const cached = getCachedServerImageModels(tabInstance);
  if (!licenseKey) {
    if (!options?.silent) {
      new Notice("Set and validate your license key first.");
    }
    return cached;
  }

  const service = new SystemSculptImageGenerationService({
    baseUrl: plugin.settings.serverUrl,
    licenseKey,
  });

  try {
    const response = await service.listModels();
    const models = Array.isArray(response.models) ? response.models : [];
    await plugin.getSettingsManager().updateSettings({
      imageGenerationModelCatalogCache: {
        fetchedAt: new Date().toISOString(),
        models,
      },
    });
    return models;
  } catch (error: any) {
    if (!cached.length) {
      throw error;
    }
    if (!options?.silent) {
      new Notice("Could not refresh image model catalog; using cached model metadata.");
    }
    return cached;
  }
}
