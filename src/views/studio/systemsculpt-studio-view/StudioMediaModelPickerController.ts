import { Notice } from "obsidian";
import type SystemSculptPlugin from "../../../main";
import { getStudioMediaCatalogs } from "../../../studio/StudioMediaCatalogs";
import { planStudioMediaNodeInputs, resolveStudioMediaNodeKind, type StudioMediaModelKind, type StudioMediaNodeInputPlan } from "../../../studio/StudioMediaModelCapabilities";
import type { StudioNodeConfigDynamicOptionsSource, StudioNodeInstance } from "../../../studio/types";
import { openStudioMediaModelPickerModal } from "../canvas/StudioMediaModelPickerModal";
import { readMediaModelFavorites, toggleMediaModelFavorite } from "../canvas/studioMediaModelFavorites";

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
  private disposed = false;
  private openRevision = 0;
  private modal: ReturnType<typeof openStudioMediaModelPickerModal> | null = null;

  constructor(private readonly host: Host) {}

  readonly open = (
    source: StudioNodeConfigDynamicOptionsSource,
    _node: StudioNodeInstance,
    currentValue: string,
    onValueChange: (value: string, label?: string) => void,
  ): void => {
    if (this.disposed) return;
    const revision = ++this.openRevision;
    const kind: StudioMediaModelKind = source === "video_generation_models" ? "video" : "image";
    void (async () => {
      try {
        const catalogs = getStudioMediaCatalogs(this.host.plugin());
        const snapshot = kind === "image" ? await catalogs.images.load() : await catalogs.videos.load();
        if (this.disposed || revision !== this.openRevision) return;
        if (snapshot.models.length === 0) {
          new Notice("No generation models are available right now.");
          return;
        }
        this.modal?.close();
        this.modal = openStudioMediaModelPickerModal(this.host.plugin().app, {
          kind,
          models: snapshot.models,
          selectedId: currentValue || ("defaultModelId" in snapshot ? snapshot.defaultModelId : ""),
          favoriteIds: readMediaModelFavorites(this.host.plugin(), kind),
          onToggleFavorite: (modelId) => toggleMediaModelFavorite(this.host.plugin(), kind, modelId),
          onSelect: (model) => onValueChange(model.id, model.name),
          onClose: () => { this.modal = null; },
        });
      } catch (error) {
        if (this.disposed || revision !== this.openRevision) return;
        new Notice(`Unable to load generation models: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  };

  planInputs(node: StudioNodeInstance): StudioMediaNodeInputPlan | null {
    if (this.disposed) return null;
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
      .then(() => { if (!this.disposed) this.host.requestRender(); })
      .catch(() => undefined)
      .finally(() => this.loading.delete(kind));
  }

  dispose(): void {
    this.disposed = true;
    this.openRevision += 1;
    this.modal?.close();
    this.modal = null;
  }
}
