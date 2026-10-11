import type { App } from "obsidian";
import {
  readStudioImageBoard,
  studioImageBoardOutputFrame,
} from "../../../../studio/StudioImageBoard";
import {
  decodeStudioImageBoardImage,
  paintStudioImageBoard,
  resolveStudioImageBoardOutputSize,
  type StudioImageBoardDecodedImage,
} from "../../../../studio/StudioImageBoardRenderer";
import type { StudioNodeInstance } from "../../../../studio/types";
import type { StudioNodeRunDisplayState } from "../../StudioRunPresentationState";
import {
  resolveStudioImageBoardBaseAsset,
  StudioImageBoardImageCache,
  type StudioImageBoardAssetIo,
} from "./StudioImageBoardImages";

const MAX_PREVIEW_SIDE = 1600;

/**
 * Paints an edited board straight onto the card when it has no flattened
 * image yet, e.g. after an undo. The card then always shows the board's real
 * state rather than a stale or unedited picture.
 */
export function mountStudioImageBoardPreview(
  parent: HTMLElement,
  options: StudioImageBoardAssetIo & {
    app: App;
    node: StudioNodeInstance;
    nodeRunState: StudioNodeRunDisplayState;
    label: string;
  }
): () => void {
  const canvas = parent.createEl("canvas", {
    cls: "ss-studio-image-board__canvas is-preview",
    attr: { role: "img", "aria-label": options.label },
  });
  const board = readStudioImageBoard(options.node.config);
  const images = new StudioImageBoardImageCache(options.readAsset);
  let base: StudioImageBoardDecodedImage | null = null;
  let disposed = false;

  void (async () => {
    const asset = await resolveStudioImageBoardBaseAsset(options);
    base = await decodeStudioImageBoardImage(await options.readAsset(asset), asset.mimeType);
    await images.loadAll(board);
    const context = disposed ? null : canvas.getContext("2d");
    if (!context) {
      return;
    }
    const baseSize = { width: base.width, height: base.height };
    const full = resolveStudioImageBoardOutputSize(board, baseSize);
    const scale = Math.min(1, MAX_PREVIEW_SIDE / Math.max(full.width, full.height));
    canvas.width = Math.max(1, Math.round(full.width * scale));
    canvas.height = Math.max(1, Math.round(full.height * scale));
    paintStudioImageBoard(context, { board, baseSize, base, images: images.images }, {
      view: studioImageBoardOutputFrame(board),
    });
  })()
    .catch(() => {
      if (!disposed) {
        // Made by the card, so it belongs to the window the card is in.
        canvas.replaceWith(
          parent.createDiv({ cls: "ss-studio-source-empty", text: "This edited image is not available on this device yet." })
        );
      }
    })
    .finally(() => {
      // The pixels are on the canvas now; the decoded sources are not needed.
      base?.close();
      images.dispose();
    });

  return () => {
    disposed = true;
  };
}
