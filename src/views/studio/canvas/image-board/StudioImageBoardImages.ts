import type { App } from "obsidian";
import { desktopHost } from "../../../../platform/desktopOnly";
import { normalizeStudioAssetRef, type StudioImageBoard } from "../../../../studio/StudioImageBoard";
import {
  decodeStudioImageBoardImage,
  type StudioImageBoardDecodedImage,
  type StudioImageBoardImage,
} from "../../../../studio/StudioImageBoardRenderer";
import { inferMimeTypeFromPath, isLikelyAbsolutePath } from "../../../../studio/nodes/shared";
import type { StudioAssetRef, StudioNodeInstance } from "../../../../studio/types";
import type { StudioNodeRunDisplayState } from "../../StudioRunPresentationState";

export type StudioImageBoardAssetIo = {
  readAsset: (asset: StudioAssetRef) => Promise<ArrayBuffer>;
  storeAsset: (bytes: ArrayBuffer, mimeType: string) => Promise<StudioAssetRef>;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The node's own, unedited image as a project asset. A node that has run
 * already staged one; a node that has not is staged here from its source path.
 */
export async function resolveStudioImageBoardBaseAsset(options: {
  app: App;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
  storeAsset: StudioImageBoardAssetIo["storeAsset"];
}): Promise<StudioAssetRef> {
  const outputs = (options.nodeRunState.outputs ?? null) as Record<string, unknown> | null;
  const staged = normalizeStudioAssetRef(outputs?.source_preview_asset);
  if (staged) {
    return staged;
  }
  const path = readString(outputs?.source_preview_path) || readString(options.node.config.sourcePath);
  const mimeType = inferMimeTypeFromPath(path);
  if (!path || !mimeType.startsWith("image/")) {
    throw new Error("Run this image node once so its image is available to edit.");
  }
  const loaded = isLikelyAbsolutePath(path)
    ? await (await desktopHost.fs()).readFile(path)
    : await options.app.vault.adapter.readBinary(path);
  const bytes = loaded instanceof ArrayBuffer ? loaded : Uint8Array.from(loaded).buffer;
  return options.storeAsset(bytes, mimeType);
}

/** Decoded images for one editing or preview surface, released together. */
export class StudioImageBoardImageCache {
  private readonly pending = new Map<string, Promise<StudioImageBoardDecodedImage>>();
  private readonly ready = new Map<string, StudioImageBoardDecodedImage>();
  private disposed = false;

  constructor(private readonly readAsset: StudioImageBoardAssetIo["readAsset"]) {}

  /** Stacked images decoded so far, by asset path. */
  get images(): ReadonlyMap<string, StudioImageBoardImage> {
    return this.ready;
  }

  get(asset: StudioAssetRef): StudioImageBoardImage | undefined {
    return this.ready.get(asset.path);
  }

  load(asset: StudioAssetRef): Promise<StudioImageBoardImage> {
    const existing = this.pending.get(asset.path);
    if (existing) {
      return existing;
    }
    const loading = this.readAsset(asset)
      .then((bytes) => decodeStudioImageBoardImage(bytes, asset.mimeType))
      .then((image) => {
        if (this.disposed) {
          image.close();
        } else {
          this.ready.set(asset.path, image);
        }
        return image;
      });
    this.pending.set(asset.path, loading);
    // A failed decode may succeed later, e.g. once a synced asset arrives.
    loading.catch(() => this.pending.delete(asset.path));
    return loading;
  }

  /** Decodes every stacked image of a board; rejects if any one cannot be read. */
  async loadAll(board: StudioImageBoard): Promise<void> {
    const loading: Array<Promise<StudioImageBoardImage>> = [];
    for (const layer of board.layers) {
      if (layer.kind === "image") {
        loading.push(this.load(layer.asset));
      }
    }
    await Promise.all(loading);
  }

  dispose(): void {
    this.disposed = true;
    for (const image of this.ready.values()) {
      image.close();
    }
    this.ready.clear();
    this.pending.clear();
  }
}
