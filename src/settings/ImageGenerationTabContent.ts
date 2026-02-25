import { Notice, Platform, Setting } from "obsidian";
import { attachFolderSuggester } from "../components/FolderSuggester";
import type { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import {
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
    text: "Configure SystemSculpt Studio (desktop-only) and run image generation through the SystemSculpt API managed backend.",
    cls: "setting-item-description",
  });

  new Setting(containerEl)
    .setName("Open SystemSculpt Studio")
    .setDesc(
      "Launch the new desktop-only Studio workspace (hard switch from CanvasFlow)."
    )
    .addButton((button) => {
      button
        .setButtonText("Open Studio")
        .setDisabled(!Platform.isDesktopApp)
        .onClick(async () => {
          if (!Platform.isDesktopApp) {
            new Notice("SystemSculpt Studio is desktop-only.");
            return;
          }
          try {
            await plugin.getViewManager().activateSystemSculptStudioView();
          } catch (error: any) {
            new Notice(`Unable to open SystemSculpt Studio: ${error?.message || error}`);
          }
        });
    });

  new Setting(containerEl)
    .setName("Studio projects folder")
    .setDesc("Default vault folder used when creating new `.systemsculpt` projects.")
    .addText((text) => {
      text
        .setPlaceholder("SystemSculpt/Studio")
        .setValue(plugin.settings.studioDefaultProjectsFolder || "SystemSculpt/Studio")
        .onChange(async (value) => {
          await plugin
            .getSettingsManager()
            .updateSettings({ studioDefaultProjectsFolder: value.trim() || "SystemSculpt/Studio" });
        });
      attachFolderSuggester(text.inputEl, (value) => text.setValue(value), tabInstance.app);
    });

  new Setting(containerEl)
    .setName("Studio run retention cap")
    .setDesc("Maximum number of completed Studio runs stored per project before oldest run data is pruned.")
    .addText((text) => {
      text
        .setPlaceholder("100")
        .setValue(String(plugin.settings.studioRunRetentionMaxRuns ?? 100))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          await plugin
            .getSettingsManager()
            .updateSettings({ studioRunRetentionMaxRuns: Math.max(1, Math.min(5000, parsed)) });
        });
      text.inputEl.inputMode = "numeric";
    });

  new Setting(containerEl)
    .setName("Studio artifact retention cap (MB)")
    .setDesc("Target maximum artifact storage per project before Studio starts pruning oldest run assets.")
    .addText((text) => {
      text
        .setPlaceholder("1024")
        .setValue(String(plugin.settings.studioRunRetentionMaxArtifactsMb ?? 1024))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          await plugin
            .getSettingsManager()
            .updateSettings({ studioRunRetentionMaxArtifactsMb: Math.max(1, Math.min(200_000, parsed)) });
        });
      text.inputEl.inputMode = "numeric";
    });

  new Setting(containerEl)
    .setName("Studio telemetry (remote)")
    .setDesc("Keep full diagnostics local; enable this only if you want redacted Studio run telemetry sent to SystemSculpt.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.studioTelemetryOptIn === true)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ studioTelemetryOptIn: value });
        });
    });

  containerEl.createEl("h3", { text: "SystemSculpt Image API (Managed)" });

  new Setting(containerEl)
    .setName("Managed image engine")
    .setDesc(
      "SystemSculpt controls the image provider and model server-side. No client-side model selection is exposed."
    );

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
    .setDesc("When enabled, writes a JSON file next to each generated image with prompt, generation settings, and job metadata.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.imageGenerationSaveMetadataSidecar !== false)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ imageGenerationSaveMetadataSidecar: value });
        });
    });

  new Setting(containerEl)
    .setName("Test image generation API")
    .setDesc("Validates your license and confirms SystemSculpt image generation access.")
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
    throw new Error("Image generation is temporarily unavailable.");
  }

  const nextModel = String(supportedModels[0]?.id || "").trim();
  if (!nextModel) {
    throw new Error("Image generation is temporarily unavailable.");
  }

  await plugin.getSettingsManager().updateSettings({
    imageGenerationDefaultModelId: nextModel,
  });
  void queueCanvasFlowLastUsedPatch(plugin, { modelId: nextModel });

  new Notice("Image generation API connection OK.");
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
      throw new Error("No managed image generation capabilities were returned by the server.");
    }
    const models = supportedModels;
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
      new Notice("Could not refresh managed image generation capabilities; using cached metadata.");
    }
    return cached;
  }
}
