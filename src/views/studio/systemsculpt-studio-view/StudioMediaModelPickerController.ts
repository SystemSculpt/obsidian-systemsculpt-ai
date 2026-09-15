import { Notice } from "obsidian";
import type SystemSculptPlugin from "../../../main";
import { getStudioMediaCatalogs } from "../../../studio/StudioMediaCatalogs";
import { planStudioMediaNodeInputs, resolveStudioMediaNodeKind, type StudioMediaModelKind, type StudioMediaNodeInputPlan } from "../../../studio/StudioMediaModelCapabilities";
import type { StudioNodeConfigDynamicOptionsSource, StudioNodeInstance } from "../../../studio/types";
import { openStudioMediaModelPickerModal } from "../graph-v3/StudioMediaModelPickerModal";
import { readMediaModelFavorites, toggleMediaModelFavorite } from "../graph-v3/studioMediaModelFavorites";

type Host = {
  /** Getter: the view constructs this controller as a class field, before parameter properties exist. */
  plugin: () => SystemSculptPlugin;
  /** Re-paints the graph once a catalog arrives so cards can gate their inputs. */
  requestRender: () => void;
};

/**
 * Owns the media model picker for the Studio view: opens the catalog modal
 * for a node's model field and answers "what does this node's model accept"
 * from the cached catalogs, kicking off a load (and one re-render) when the
 * catalog has not been fetched yet.
 */
export class StudioMediaModelPickerController {
  private readonly loading = new Set<StudioMediaModelKind>();

  constructor(private readonly host: Host) {}

  readonly open = (
    source: StudioNodeConfigDynamicOptionsSource,
    _node: StudioNodeInstance,
    currentValue: string,
    onValueChange: (value: string, label?: string) => void,
  ): void => {
    const kind: StudioMediaModelKind = source === "video_generation_models" ? "video" : "image";
    void (async () => {
      try {
        const catalogs = getStudioMediaCatalogs(this.host.plugin());
        const snapshot = kind === "image" ? await catalogs.images.load() : await catalogs.videos.load();
        if (snapshot.models.length === 0) {
          new Notice("No generation models are available right now.");
          return;
        }
        openStudioMediaModelPickerModal(this.host.plugin().app, {
          kind,
          models: snapshot.models,
          selectedId: currentValue || ("defaultModelId" in snapshot ? snapshot.defaultModelId : ""),
          favoriteIds: readMediaModelFavorites(this.host.plugin(), kind),
          onToggleFavorite: (modelId) => toggleMediaModelFavorite(this.host.plugin(), kind, modelId),
          onSelect: (model) => onValueChange(model.id, model.name),
        });
      } catch (error) {
        new Notice(`Unable to load generation models: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  };

  planInputs(node: StudioNodeInstance): StudioMediaNodeInputPlan | null {
    const kind = resolveStudioMediaNodeKind(node.kind);
    if (!kind) return null;
    const catalogs = getStudioMediaCatalogs(this.host.plugin());
    const snapshots = { images: catalogs.images.peek(), videos: catalogs.videos.peek() };
    if ((kind === "image" ? snapshots.images : snapshots.videos) === null) this.warm(kind);
    return planStudioMediaNodeInputs(node, snapshots);
  }

  private warm(kind: StudioMediaModelKind): void {
    if (this.loading.has(kind)) return;
    this.loading.add(kind);
    const catalogs = getStudioMediaCatalogs(this.host.plugin());
    void (kind === "image" ? catalogs.images.load() : catalogs.videos.load())
      .then(() => this.host.requestRender())
      .catch(() => undefined)
      .finally(() => this.loading.delete(kind));
  }
}
