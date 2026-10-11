/** @jest-environment jsdom */

import {
  createEmptyStudioImageBoard,
  createStudioImageBoardLayer,
  readStudioImageBoard,
  serializeStudioImageBoard,
  STUDIO_IMAGE_BOARD_CONFIG_KEY,
  studioImageBoardDrawingKey,
  studioImageBoardWithRender,
  type StudioImageBoard,
} from "../../../studio/StudioImageBoard";
import { composeStudioImageBoardAsset } from "../../../studio/StudioImageBoardRenderer";
import type { StudioAssetRef, StudioJsonValue, StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import { resolveStudioImageBoardBaseAsset } from "../canvas/image-board/StudioImageBoardImages";
import { SystemSculptStudioView } from "../SystemSculptStudioView";

jest.mock("../../../studio/StudioImageBoardRenderer", () => ({
  ...jest.requireActual("../../../studio/StudioImageBoardRenderer"),
  composeStudioImageBoardAsset: jest.fn(),
}));
jest.mock("../canvas/image-board/StudioImageBoardImages", () => ({
  ...jest.requireActual("../canvas/image-board/StudioImageBoardImages"),
  resolveStudioImageBoardBaseAsset: jest.fn(),
}));

const viewPrototype = (SystemSculptStudioView as any).prototype;
const asset = (name: string): StudioAssetRef => ({
  hash: name.padEnd(64, "0"),
  path: `Studio/assets/${name}.png`,
  mimeType: "image/png",
  sizeBytes: 16,
});
const SOURCE = asset("source");
const FLATTENED = asset("flattened");

function blurred(): StudioImageBoard {
  const board = createEmptyStudioImageBoard();
  board.layers.push(createStudioImageBoardLayer({ kind: "redact", id: "hide" }));
  return board;
}

function harness(config: Record<string, StudioJsonValue> = {}, outputs: Record<string, unknown> | null = null) {
  const node: StudioNodeInstance = {
    id: "node_media",
    kind: "studio.media_ingest",
    version: "1.0.0",
    title: "Media",
    position: { x: 0, y: 0 },
    config: { sourcePath: "Attachments/shot.png", ...config },
    continueOnError: false,
    disabled: false,
  };
  const project = { graph: { nodes: [node] } } as unknown as StudioProjectV1;
  const context: any = {
    app: {},
    currentProject: project,
    currentProjectPath: "Studio/Project.systemsculpt",
    plugin: { getStudioService: () => ({ storeAsset: jest.fn(), readAsset: jest.fn() }) },
    runPresentation: { getNodeState: () => ({ status: "idle", message: "", updatedAt: null, outputs }) },
    findNode: (target: StudioProjectV1, id: string) => target.graph.nodes.find((entry) => entry.id === id) ?? null,
    commitCurrentProjectMutationAsync: jest.fn(
      async (_reason: string, mutator: (target: StudioProjectV1) => Promise<boolean | void>) =>
        (await mutator(project)) !== false
    ),
    render: jest.fn(),
  };
  context.ensureRenderedImageAssetForNode = viewPrototype.ensureRenderedImageAssetForNode;
  return {
    node,
    context,
    picture: (): Promise<StudioAssetRef | null> => context.ensureRenderedImageAssetForNode(node),
    board: (): StudioImageBoard => readStudioImageBoard(node.config),
  };
}

describe("SystemSculptStudioView: the picture an image node shows", () => {
  beforeEach(() => {
    jest.mocked(resolveStudioImageBoardBaseAsset).mockReset().mockResolvedValue(SOURCE);
    jest.mocked(composeStudioImageBoardAsset).mockReset().mockResolvedValue(FLATTENED);
  });

  it("is the node's own image when nothing was edited, staged if the node never ran", async () => {
    const h = harness();

    await expect(h.picture()).resolves.toEqual(SOURCE);

    expect(resolveStudioImageBoardBaseAsset).toHaveBeenCalledTimes(1);
    expect(composeStudioImageBoardAsset).not.toHaveBeenCalled();
    expect(h.context.commitCurrentProjectMutationAsync).not.toHaveBeenCalled();
  });

  it("is flattened from the staged image when there are edits, and put on record as being of them", async () => {
    const board = blurred();
    const h = harness({ [STUDIO_IMAGE_BOARD_CONFIG_KEY]: serializeStudioImageBoard(board) });

    await expect(h.picture()).resolves.toEqual(FLATTENED);

    expect(jest.mocked(composeStudioImageBoardAsset).mock.calls[0][0]).toMatchObject({ baseImage: SOURCE });
    expect(h.board().lastRenderedAsset).toEqual(FLATTENED);
    expect(h.board().sourceAssetPath).toBe(SOURCE.path);
    expect(h.board().lastRenderedOf).toBe(studioImageBoardDrawingKey(board));
    // Bookkeeping, not an edit to undo.
    expect(h.context.commitCurrentProjectMutationAsync.mock.calls[0][2]).toEqual({ captureHistory: false });

    // The second time it is simply read back.
    await expect(h.picture()).resolves.toEqual(FLATTENED);
    expect(composeStudioImageBoardAsset).toHaveBeenCalledTimes(1);
  });

  it("is flattened again when the picture on record is of other layers", async () => {
    // As an undo leaves it: the blur is back on the board, the picture is from before it.
    const stale = asset("stale");
    const h = harness({
      [STUDIO_IMAGE_BOARD_CONFIG_KEY]: serializeStudioImageBoard(
        studioImageBoardWithRender(blurred(), createEmptyStudioImageBoard(), SOURCE.path, stale)
      ),
    });

    await expect(h.picture()).resolves.toEqual(FLATTENED);

    expect(composeStudioImageBoardAsset).toHaveBeenCalledTimes(1);
    expect(h.board().lastRenderedAsset).toEqual(FLATTENED);
  });

  it("is never the unedited source, or an earlier output, when an edited image cannot be flattened", async () => {
    jest.mocked(resolveStudioImageBoardBaseAsset).mockRejectedValue(new Error("still syncing"));
    const h = harness(
      { [STUDIO_IMAGE_BOARD_CONFIG_KEY]: serializeStudioImageBoard(blurred()) },
      // An output left from a run made before the blur was added.
      { preview_asset: SOURCE, preview_path: SOURCE.path }
    );

    await expect(h.picture()).resolves.toBeNull();

    expect(composeStudioImageBoardAsset).not.toHaveBeenCalled();
  });

  it("falls back to the last output only for an image with no edits", async () => {
    jest.mocked(resolveStudioImageBoardBaseAsset).mockRejectedValue(new Error("still syncing"));
    const h = harness({}, { preview_asset: SOURCE, preview_path: SOURCE.path });

    await expect(h.picture()).resolves.toEqual(SOURCE);
  });

  it("keeps what was done to the node while its picture was being made, and does not call that picture its own", async () => {
    const board = blurred();
    const h = harness({ [STUDIO_IMAGE_BOARD_CONFIG_KEY]: serializeStudioImageBoard(board) });
    const moved = { ...board, layers: [...board.layers, createStudioImageBoardLayer({ kind: "highlight", id: "mark" })] };
    jest.mocked(composeStudioImageBoardAsset).mockImplementation(async () => {
      h.node.config[STUDIO_IMAGE_BOARD_CONFIG_KEY] = serializeStudioImageBoard(moved);
      return FLATTENED;
    });

    await h.picture();

    expect(h.board().layers.map((layer) => layer.id)).toEqual(["base", "hide", "mark"]);
    expect(h.board().lastRenderedAsset).toBeNull();
  });
});
