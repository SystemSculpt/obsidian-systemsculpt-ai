/** @jest-environment jsdom */
import type { App } from "obsidian";
import {
  createEmptyStudioImageBoard,
  createStudioImageBoardLayer,
  serializeStudioImageBoard,
  STUDIO_IMAGE_BOARD_CONFIG_KEY,
} from "../../../../studio/StudioImageBoard";
import type { StudioNodeDefinition, StudioNodeInstance, StudioProjectV1 } from "../../../../studio/types";
import type { StudioImageBoardEditorHandle } from "../image-board/StudioImageBoardEditor";
import {
  flushImageBoard,
  installImageBoardTestCanvas,
  restoreImageBoardTestCanvas,
} from "../image-board/__tests__/imageBoardTestCanvas";
import {
  renderStudioGraphWorkspace,
  type StudioGraphWorkspaceRendererOptions,
} from "../StudioGraphWorkspaceRenderer";

const SOURCE = { hash: "s".repeat(64), path: "Studio/assets/source.png", mimeType: "image/png", sizeBytes: 42 };
const RENDERED = { hash: "r".repeat(64), path: "Studio/assets/rendered.png", mimeType: "image/png", sizeBytes: 12 };

const mediaDefinition: StudioNodeDefinition = {
  kind: "studio.media_ingest",
  version: "1.0.0",
  requiredHostCapabilities: [],
  capabilityClass: "local_io",
  cachePolicy: "by_inputs",
  inputPorts: [{ id: "media", type: "any", required: false }],
  outputPorts: [{ id: "path", type: "text" }],
  configDefaults: { sourcePath: "" },
  configSchema: { fields: [{ key: "sourcePath", label: "Source path", type: "media_path" }], allowUnknownKeys: true },
  async execute() {
    return { outputs: {} };
  },
};

function mediaNode(config: StudioNodeInstance["config"] = {}): StudioNodeInstance {
  return {
    id: "media",
    kind: "studio.media_ingest",
    version: "1.0.0",
    title: "Media",
    position: { x: 0, y: 0 },
    config: { sourcePath: SOURCE.path, ...config },
    continueOnError: false,
    disabled: false,
  };
}

function project(nodes: StudioNodeInstance[]): StudioProjectV1 {
  return {
    schema: "studio.project.v1", projectId: "board", name: "Board", createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
    engine: { apiMode: "systemsculpt_only", minPluginVersion: "0.0.0" },
    graph: { nodes, edges: [], entryNodeIds: [], groups: [] },
    permissionsRef: { policyVersion: 1, policyPath: "policy.json" },
    settings: { runConcurrency: "adaptive", defaultFsScope: "vault", retention: { maxRuns: 10, maxArtifactsMb: 10 } },
    migrations: { projectSchemaVersion: "1.0.0", applied: [] },
  };
}

function harness(node: StudioNodeInstance, initial: { previewReady?: boolean } = {}) {
  const no = jest.fn();
  const state = {
    project: project([node]),
    editing: false,
    previewReady: initial.previewReady ?? true,
    editor: null as StudioImageBoardEditorHandle | null,
  };
  const mounted = jest.fn((_id: string, editor: StudioImageBoardEditorHandle) => {
    state.editor = editor;
  });
  const unmounted = jest.fn((_id: string, editor: StudioImageBoardEditorHandle) => {
    if (state.editor === editor) state.editor = null;
  });
  const root = document.body.createDiv();
  const graphInteraction = {
    registerViewportElement: no, handleGraphViewportWheel: no, startMarqueeSelection: no, startCanvasPan: no,
    getGraphZoom: () => 1, registerSurfaceElement: no, registerCanvasElement: no, registerMarqueeElement: no,
    registerAlignmentGuidesElement: no, registerZoomLabelElement: no, registerEdgesLayerElement: no,
    clearGraphElementMaps: no, registerNodeElement: no, registerPortElement: no, renderGroupLayer: no,
    refreshNodeSelectionClasses: no, applyGraphZoom: no, refreshSelectionResizeFrame: no,
    isNodeSelected: () => false, onNodeRemoved: no, notifyNodePositionsChanged: no,
    getNodeElement: (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`),
    isPendingConnectionSource: () => false, getPendingConnection: () => null,
    showNodeResizeGuides: no, clearAlignmentGuides: no, startNodeDrag: no, toggleNodeSelection: no,
  } as unknown as StudioGraphWorkspaceRendererOptions["graphInteraction"];
  const options = (): StudioGraphWorkspaceRendererOptions => ({
    root, busy: false, currentProject: state.project, currentProjectPath: "Studio/Board.systemsculpt",
    nodeDetailMode: "expanded", graphInteraction,
    getNodeRunState: () => ({
      status: "idle", message: "", updatedAt: null,
      outputs: { path: SOURCE.path, preview_path: SOURCE.path, source_preview_path: SOURCE.path, source_preview_asset: SOURCE },
    }),
    findNodeDefinition: () => mediaDefinition,
    resolveAssetPreviewSrc: (path) => (state.previewReady ? `app://local/${path}` : null),
    onRunGraph: no, onOpenAddNodeMenuAtViewportCenter: no, activeCanvasTool: "select", onSelectCanvasTool: no,
    shapeLayer: { selection: { shapeIds: [], arrowIds: [] }, onSelect: no, onMoveSelection: no, onResizeShape: no, onLabelChange: no, onArrowLabelChange: no, onConnectShapes: no, registerLayerHandle: no },
    onZoomIn: no, onZoomOut: no, onZoomReset: no, onZoomOverview: no, onToggleNodeDetailMode: no, onOpenNodeContextMenu: no,
    onCreateTextNodeAtPosition: no, onRunNode: no, onCopyTextGenerationPromptBundle: no, onToggleTextGenerationOutputLock: no,
    onRemoveNode: no, onNodeTitleInput: no, onNodeConfigMutated: no, onNodeConfigValueChange: no, onNodeGeometryMutated: no,
    takeTextNodeEditorMountState: () => ({ isEditing: false, shouldAutoFocus: false }), onRequestTextNodeEdit: no, onStopTextNodeEdit: no, onRevealPathInFinder: no,
    onOpenImageEditor: no,
    isImageNodeEditing: (id) => state.editing && id === "media",
    imageBoard: {
      app: {} as App,
      readAsset: async () => new ArrayBuffer(8),
      storeAsset: jest.fn(),
      isEditing: (id) => state.editing && id === "media",
      onEditorMounted: mounted,
      onEditorUnmounted: unmounted,
      onClose: no,
    },
  });
  const workspace = renderStudioGraphWorkspace(options());
  const card = (): HTMLElement => root.querySelector<HTMLElement>('[data-node-id="media"]')!;
  return { state, root, workspace, card, mounted, unmounted, refresh: () => workspace.refresh(options()) };
}

beforeEach(() => {
  installImageBoardTestCanvas();
});

afterEach(() => {
  restoreImageBoardTestCanvas();
  document.body.empty();
});

describe("image node edited on the canvas", () => {
  it("swaps the picture for the editor inside the same card and docks the tools over the workspace", async () => {
    const { state, root, card, mounted, refresh } = harness(mediaNode());
    expect(card().querySelector("img")).not.toBeNull();
    expect(card().querySelector('[data-media-action="edit"]')).not.toBeNull();

    state.editing = true;
    refresh();
    await flushImageBoard();

    expect(card().classList.contains("is-image-editing")).toBe(true);
    expect(card().querySelector(".ss-studio-image-board canvas")).not.toBeNull();
    expect(card().querySelector("img")).toBeNull();
    // The editor's own bar replaces the card actions; it floats over the workspace, not inside the zoomed card.
    expect(card().querySelector(".ss-studio-media-action-bar")).toBeNull();
    expect(root.querySelector(".ss-studio-graph-workspace > .ss-studio-image-board-toolbar.is-docked")).not.toBeNull();
    expect(card().dataset.chromeLayout).toBe("media");
    expect(mounted).toHaveBeenCalledWith("media", expect.objectContaining({ handleKeyDown: expect.any(Function) }));
  });

  it("keeps the same editor mounted while its node changes, and hands it the change", async () => {
    const { state, card, mounted, refresh } = harness(mediaNode());
    state.editing = true;
    refresh();
    await flushImageBoard();
    const element = card();
    const sync = jest.spyOn(state.editor!, "syncNode");
    const board = createEmptyStudioImageBoard();
    board.layers.push(createStudioImageBoardLayer({ kind: "highlight" }));

    state.project = project([mediaNode({ [STUDIO_IMAGE_BOARD_CONFIG_KEY]: serializeStudioImageBoard(board) })]);
    refresh();

    expect(card()).toBe(element);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(state.project.graph.nodes[0]);
  });

  it("returns to the picture and takes its toolbar away when editing ends", async () => {
    const { state, root, card, unmounted, refresh } = harness(mediaNode());
    state.editing = true;
    refresh();
    await flushImageBoard();

    state.editing = false;
    refresh();

    expect(unmounted).toHaveBeenCalledTimes(1);
    expect(state.editor).toBeNull();
    expect(card().classList.contains("is-image-editing")).toBe(false);
    expect(card().querySelector(".ss-studio-image-board")).toBeNull();
    expect(card().querySelector("img")).not.toBeNull();
    expect(card().querySelector('[data-media-action="edit"]')).not.toBeNull();
    expect(root.querySelector(".ss-studio-image-board-toolbar")).toBeNull();
  });

  it("releases the editor when its node is removed", async () => {
    const { state, root, unmounted, refresh } = harness(mediaNode());
    state.editing = true;
    refresh();
    await flushImageBoard();

    state.project = project([]);
    refresh();

    expect(unmounted).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".ss-studio-image-board-toolbar")).toBeNull();
  });

  it("shows the baked image for an edited board, and paints it live when there is none", async () => {
    const edited = createEmptyStudioImageBoard();
    edited.layers.push(createStudioImageBoardLayer({ kind: "redact" }));
    const baked = harness(
      mediaNode({
        [STUDIO_IMAGE_BOARD_CONFIG_KEY]: serializeStudioImageBoard({ ...edited, sourceAssetPath: SOURCE.path, lastRenderedAsset: RENDERED }),
      })
    );
    expect(baked.card().querySelector("img")!.getAttribute("data-studio-asset-path")).toBe(RENDERED.path);
    expect(baked.card().querySelector("canvas")).toBeNull();
    document.body.empty();

    // After an undo the cached render is gone: the card must not fall back to the unedited source.
    const unbaked = harness(mediaNode({ [STUDIO_IMAGE_BOARD_CONFIG_KEY]: serializeStudioImageBoard(edited) }));
    await flushImageBoard();

    expect(unbaked.card().querySelector("img")).toBeNull();
    expect(unbaked.card().querySelector("canvas.ss-studio-image-board__canvas.is-preview")).not.toBeNull();
  });

  it("turns into the image card when its preview resolves after the first paint", () => {
    // The asset's bytes are confirmed asynchronously, so the first paint can only be a form.
    const { state, card, refresh } = harness(mediaNode(), { previewReady: false });
    expect(card().dataset.surface).toBe("form");

    state.previewReady = true;
    refresh();

    expect(card().dataset.surface).toBe("media");
    expect(card().querySelector("img")).not.toBeNull();
  });
});
