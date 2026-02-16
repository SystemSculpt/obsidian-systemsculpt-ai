import { Notice, Setting } from "obsidian";
import { ListSelectionModal, type ListItem } from "../core/ui/modals/standard/ListSelectionModal";
import { attachFolderSuggester } from "../components/FolderSuggester";
import type { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import {
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  formatCuratedImageModelOptionText,
  getCuratedImageGenerationModelGroups,
  mergeImageGenerationServerCatalogModels,
  type ImageGenerationServerCatalogModel,
} from "../services/canvasflow/ImageGenerationModelCatalog";
import { SystemSculptImageGenerationService } from "../services/canvasflow/SystemSculptImageGenerationService";
import { queueCanvasFlowLastUsedPatch } from "../services/canvasflow/CanvasFlowPromptDefaults";

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
        const nextModel = value.trim() || DEFAULT_IMAGE_GENERATION_MODEL_ID;
        void queueCanvasFlowLastUsedPatch(plugin, { modelId: nextModel });
        await plugin
          .getSettingsManager()
          .updateSettings({ imageGenerationDefaultModelId: nextModel });
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
  const supportedModels = models.filter((model) => model.supports_generation !== false);
  if (supportedModels.length === 0) {
    throw new Error("No image generation models were returned by the server.");
  }

  const configured = String(plugin.settings.imageGenerationDefaultModelId || "").trim();
  const fallback = supportedModels[0]?.id || DEFAULT_IMAGE_GENERATION_MODEL_ID;
  const nextModel = configured && supportedModels.some((model) => model.id === configured) ? configured : fallback;

  await plugin.getSettingsManager().updateSettings({
    imageGenerationDefaultModelId: nextModel,
  });
  void queueCanvasFlowLastUsedPatch(plugin, { modelId: nextModel });

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
      const supportLabel = model.supportsGeneration ? "Runnable in SystemSculpt backend." : "Visible for pricing only (not yet runnable).";
      items.push({
        id: model.id,
        title: model.supportsGeneration
          ? formatCuratedImageModelOptionText(model)
          : `${formatCuratedImageModelOptionText(model)} (Not supported yet)`,
        description: `${supportLabel} ${model.pricing.lines.join(" | ")}`.trim(),
        icon: "image",
        badge: model.pricing.summary,
        selected: model.id === currentDefault,
        metadata: { id: model.id, provider: group.provider, supportsGeneration: model.supportsGeneration === true },
      });
    }
  }

  const modal = new ListSelectionModal(tabInstance.app, items, {
    title: "Image models",
    description: "Merged from the live SystemSculpt API catalog and OpenRouter marketplace image catalog. Shows provider USD and estimated SystemSculpt credits per image.",
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
  const supportsGeneration = selection?.metadata?.supportsGeneration === true;
  if (!modelId) {
    return;
  }
  if (!supportsGeneration) {
    new Notice("That model is not currently supported by the SystemSculpt image backend. Pick a runnable model.");
    return;
  }

  await plugin.getSettingsManager().updateSettings({
    imageGenerationDefaultModelId: modelId,
  });
  void queueCanvasFlowLastUsedPatch(plugin, { modelId });

  new Notice("Default image model updated.");
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
      supports_generation:
        typeof (model as any)?.supports_generation === "boolean"
          ? (model as any).supports_generation
          : undefined,
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
      estimated_cost_per_image_usd:
        typeof (model as any)?.estimated_cost_per_image_usd === "number" &&
        Number.isFinite((model as any).estimated_cost_per_image_usd)
          ? (model as any).estimated_cost_per_image_usd
          : undefined,
      estimated_cost_per_image_low_usd:
        typeof (model as any)?.estimated_cost_per_image_low_usd === "number" &&
        Number.isFinite((model as any).estimated_cost_per_image_low_usd)
          ? (model as any).estimated_cost_per_image_low_usd
          : undefined,
      estimated_cost_per_image_high_usd:
        typeof (model as any)?.estimated_cost_per_image_high_usd === "number" &&
        Number.isFinite((model as any).estimated_cost_per_image_high_usd)
          ? (model as any).estimated_cost_per_image_high_usd
          : undefined,
      pricing_source: String((model as any)?.pricing_source || "").trim() || undefined,
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
    const supportedModels = Array.isArray(response.models) ? response.models : [];
    if (supportedModels.length === 0) {
      throw new Error("No supported image models were returned by /images/models.");
    }
    const openRouterModels = await service.listOpenRouterMarketplaceImageModels().catch(() => []);
    const models = mergeImageGenerationServerCatalogModels(
      supportedModels,
      openRouterModels
    );
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
