import { Notice, Setting } from "obsidian";
import { ListSelectionModal, type ListItem } from "../core/ui/modals/standard/ListSelectionModal";
import { attachFolderSuggester } from "../components/FolderSuggester";
import type { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { ReplicateImageService } from "../services/canvasflow/ReplicateImageService";

export async function displayImageGenerationTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "image-generation";
  }

  const { plugin } = tabInstance;

  containerEl.createEl("h3", { text: "Image Generation" });
  containerEl.createEl("p", {
    text: "Configure Replicate and enable CanvasFlow (experimental) to run ComfyUI-like image graphs inside Obsidian Canvas.",
    cls: "setting-item-description",
  });

  new Setting(containerEl)
    .setName("Enable CanvasFlow enhancements (experimental)")
    .setDesc(
      "Adds a CanvasFlow Run button to the Canvas selection toolbar and injects prompt controls into CanvasFlow prompt nodes. Desktop-only. Expect breakage after Obsidian updates."
    )
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.canvasFlowEnabled === true)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ canvasFlowEnabled: value });
          new Notice(value ? "CanvasFlow enabled." : "CanvasFlow disabled.");
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
    .setDesc("Used when a CanvasFlow prompt node doesn't specify ss_replicate_model. Use the browser button to pick a model.");

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
    .setDesc("How often CanvasFlow checks Replicate for status updates.")
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
  const key = String(plugin.settings.replicateApiKey || "").trim();
  if (!key) {
    new Notice("Set your Replicate API key first.");
    return;
  }

  const service = new ReplicateImageService(key);
  const loadingItem: ListItem = {
    id: "replicate-loading",
    title: "Loading models...",
    description: "Fetching recent models from Replicate",
    icon: "loader",
  };

  let browseItems: ListItem[] = [loadingItem];
  let browseNextUrl: string | null = null;
  let browseMode: "image" | "all" = "image";
  let browseLoading = false;
  let lastQuery = "";

  let loadMoreBtn: HTMLButtonElement | null = null;
  let imageModelsBtn: HTMLButtonElement | null = null;
  let browseAllBtn: HTMLButtonElement | null = null;

  const toListItem = (model: { slug: string; description?: string; coverImageUrl?: string }): ListItem => ({
    id: model.slug,
    title: model.slug,
    description: model.description,
    icon: "image",
    thumbnail: model.coverImageUrl,
    metadata: { slug: model.slug },
  });

  const updateBrowseControls = () => {
    const canLoadMore = !!browseNextUrl && !browseLoading && lastQuery.trim().length < 2;
    if (loadMoreBtn) {
      loadMoreBtn.disabled = !canLoadMore;
      loadMoreBtn.textContent = browseLoading ? "Loading..." : browseNextUrl ? "Load more" : "No more pages";
    }
    if (imageModelsBtn) {
      imageModelsBtn.disabled = browseLoading;
      imageModelsBtn.toggleClass("ss-active", browseMode === "image" && lastQuery.trim().length < 2);
    }
    if (browseAllBtn) {
      browseAllBtn.disabled = browseLoading;
      browseAllBtn.toggleClass("ss-active", browseMode === "all" && lastQuery.trim().length < 2);
    }
  };

  const loadRecentFirstPage = async (): Promise<void> => {
    if (browseLoading) return;
    browseLoading = true;
    updateBrowseControls();
    try {
      browseMode = "all";
      const page = await service.listModelsPage({ sortBy: "latest_version_created_at", sortDirection: "desc" });
      browseNextUrl = page.next;
      browseItems = page.results.map(toListItem);
    } catch (error: any) {
      browseNextUrl = null;
      browseItems = [
        {
          id: "replicate-browse-error",
          title: "Failed to load models",
          description: String(error?.message || error || "Unknown error"),
          icon: "alert-triangle",
        },
      ];
    } finally {
      browseLoading = false;
      updateBrowseControls();
      modal.setItems(browseItems);
    }
  };

  const loadImageModels = async (): Promise<void> => {
    if (browseLoading) return;
    browseLoading = true;
    browseMode = "image";
    browseNextUrl = null;
    browseItems = [
      {
        id: "replicate-loading-image-models",
        title: "Loading image models...",
        description: "Querying Replicate search",
        icon: "loader",
      },
    ];
    updateBrowseControls();
    modal.setItems(browseItems);

    try {
      // Replicate does not expose a reliable "list all image generation models" endpoint.
      // This is a best-effort list built from multiple image-related searches.
      const queries = ["text-to-image", "image-to-image", "image-editing", "upscale"];
      const bySlug = new Map<string, ListItem>();
      for (const q of queries) {
        const results = await service.searchModels(q, { limit: 50 });
        for (const model of results) {
          const item = toListItem(model);
          if (!bySlug.has(item.id)) {
            bySlug.set(item.id, item);
          }
        }
      }
      browseItems = Array.from(bySlug.values()).sort((a, b) => a.title.localeCompare(b.title));
    } catch (error: any) {
      browseItems = [
        {
          id: "replicate-image-models-error",
          title: "Failed to load image models",
          description: String(error?.message || error || "Unknown error"),
          icon: "alert-triangle",
        },
      ];
    } finally {
      browseLoading = false;
      updateBrowseControls();
      modal.setItems(browseItems);
    }
  };

  const loadMoreRecent = async (): Promise<void> => {
    if (browseLoading) return;
    if (lastQuery.trim().length >= 2) {
      new Notice("Clear the search box to browse pages of models.");
      return;
    }
    if (!browseNextUrl) return;

    browseLoading = true;
    updateBrowseControls();
    try {
      const page = await service.listModelsPage({ url: browseNextUrl });
      browseNextUrl = page.next;
      const existing = new Set(browseItems.map((i) => i.id));
      const nextItems = page.results.map(toListItem).filter((i) => !existing.has(i.id));
      browseItems = [...browseItems, ...nextItems];
      modal.setItems(browseItems);
    } catch (error: any) {
      new Notice(`Failed to load more models: ${error?.message || error}`);
    } finally {
      browseLoading = false;
      updateBrowseControls();
    }
  };

  const modal = new ListSelectionModal(tabInstance.app, browseItems, {
    title: "Replicate models",
    description:
      'Pick an image model. Tip: search for "flux", "sdxl", "image", "upscale", etc. Clear search to browse recent models (paginated).',
    withSearch: true,
    size: "large",
    customContent: (containerEl) => {
      const hint = containerEl.createEl("p", {
        text: 'Pick a model from the list. Tip: search for "flux", "sdxl", "image", "upscale", etc. You can always change this later.',
        cls: "setting-item-description",
      });
      hint.style.marginTop = "0";

      const controls = containerEl.createDiv({ cls: "ss-button-container" });
      imageModelsBtn = controls.createEl("button", { text: "Image models", cls: "ss-button mod-cta" });
      imageModelsBtn.type = "button";
      imageModelsBtn.addEventListener("click", () => {
        void loadImageModels();
      });

      browseAllBtn = controls.createEl("button", { text: "Browse all models", cls: "ss-button ss-button--secondary" });
      browseAllBtn.type = "button";
      browseAllBtn.addEventListener("click", () => {
        void loadRecentFirstPage();
      });

      loadMoreBtn = controls.createEl("button", { text: "Load more", cls: "ss-button ss-button--secondary" });
      loadMoreBtn.type = "button";
      loadMoreBtn.addEventListener("click", () => {
        void loadMoreRecent();
      });

      updateBrowseControls();
    },
  });

  modal.setCustomSearchHandler(async (query: string): Promise<ListItem[]> => {
    lastQuery = String(query || "");
    updateBrowseControls();
    try {
      const trimmed = String(query || "").trim();
      if (trimmed.length < 2) {
        return browseItems;
      }

      const results = await service.searchModels(trimmed, { limit: 50 });
      return results.map(toListItem);
    } catch (error: any) {
      return [
        {
          id: "replicate-search-error",
          title: "Search failed",
          description: String(error?.message || error || "Unknown error"),
          icon: "alert-triangle",
        },
      ];
    }
  });

  // Default to an image-focused list (best-effort). Users can switch to browsing all models.
  void loadImageModels();

  const [selection] = await modal.openAndGetSelection();
  const slug = String(selection?.metadata?.slug || "").trim();
  if (!slug) {
    return;
  }

  try {
    const details = await service.resolveLatestVersion(slug);
    await plugin.getSettingsManager().updateSettings({
      replicateDefaultModelSlug: details.slug,
      replicateResolvedVersion: details.latestVersionId,
    });
    new Notice(`Default Replicate model set to ${details.slug}`);
    tabInstance.display();
  } catch (error: any) {
    await plugin.getSettingsManager().updateSettings({
      replicateDefaultModelSlug: slug,
      replicateResolvedVersion: "",
    });
    new Notice(`Set default model to ${slug}, but failed to resolve version: ${error?.message || error}`);
    tabInstance.display();
  }
}
