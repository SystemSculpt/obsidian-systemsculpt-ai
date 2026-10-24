import { Notice } from "obsidian";
import type SystemSculptPlugin from "../../../main";
import { getStudioMediaCatalogs } from "../../../studio/StudioMediaCatalogs";
import { planStudioMediaNodeInputs, resolveStudioMediaNodeKind, type StudioMediaNodeInputPlan } from "../../../studio/StudioMediaModelCapabilities";
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
 * Owns the video model picker for the Studio view: opens the catalog modal
 * for a node's model field and answers "what does this node's model accept"
 * from the cached catalog, kicking off a load (and one re-render) when the
 * catalog has not been fetched yet.
 */
export class StudioMediaModelPickerController {
  private loading = false;
  private disposed = false;
  private openRevision = 0;
  private modal: ReturnType<typeof openStudioMediaModelPickerModal> | null = null;

  constructor(private readonly host: Host) {}

  readonly open = (
    source: StudioNodeConfigDynamicOptionsSource,
    node: StudioNodeInstance,
    currentValue: string,
    onValueChange: (value: string, label?: string) => void,
  ): void => {
    if (this.disposed || source !== "video_generation_models" || !resolveStudioMediaNodeKind(node.kind)) return;
    const revision = ++this.openRevision;
    void (async () => {
      try {
        const snapshot = await getStudioMediaCatalogs(this.host.plugin()).videos.load();
        if (this.disposed || revision !== this.openRevision) return;
        if (snapshot.models.length === 0) {
          new Notice("No generation models are available right now.");
          return;
        }
        this.modal?.close();
        this.modal = openStudioMediaModelPickerModal(this.host.plugin().app, {
          kind: "video",
          models: snapshot.models,
          selectedId: currentValue,
          favoriteIds: readMediaModelFavorites(this.host.plugin(), "video"),
          onToggleFavorite: (modelId) => toggleMediaModelFavorite(this.host.plugin(), "video", modelId),
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
    if (this.disposed || !resolveStudioMediaNodeKind(node.kind)) return null;
    const snapshots = { videos: getStudioMediaCatalogs(this.host.plugin()).videos.peek() };
    if (snapshots.videos === null) this.warm();
    return planStudioMediaNodeInputs(node, snapshots);
  }

  private warm(): void {
    if (this.loading) return;
    this.loading = true;
    void getStudioMediaCatalogs(this.host.plugin()).videos.load()
      .then(() => { if (!this.disposed) this.host.requestRender(); })
      .catch(() => undefined)
      .finally(() => { this.loading = false; });
  }

  dispose(): void {
    this.disposed = true;
    this.openRevision += 1;
    this.modal?.close();
    this.modal = null;
  }
}
