import {
  readStudioImageBoard,
  STUDIO_IMAGE_BOARD_CONFIG_KEY,
} from "../../../../../studio/StudioImageBoard";
import type { StudioJsonValue } from "../../../../../studio/types";
import { StudioImageBoardSession } from "../StudioImageBoardSession";

const RENDERED = { hash: "r".repeat(64), path: "assets/rendered.png", mimeType: "image/png", sizeBytes: 12 };

function harness(config: Record<string, StudioJsonValue> = {}) {
  const store = { ...config };
  const commits: Array<{ key: string; options: unknown }> = [];
  const onChange = jest.fn();
  const session = new StudioImageBoardSession(
    store,
    (key, value, options) => {
      store[key] = value;
      commits.push({ key, options });
    },
    onChange
  );
  return { session, store, commits, onChange, saved: () => readStudioImageBoard(store) };
}

describe("StudioImageBoardSession", () => {
  it("adds a layer on top, selects it, and returns to the select tool", () => {
    const { session, saved, commits } = harness();
    session.setTool("rect");

    const layer = session.addLayer({ kind: "shape", shape: "rect", x: 0.1, y: 0.1, width: 0.2, height: 0.2 });

    expect(saved().layers.map((entry) => entry.kind)).toEqual(["base", "shape"]);
    expect(session.selectedId).toBe(layer.id);
    expect(session.tool).toBe("select");
    expect(commits).toEqual([{ key: STUDIO_IMAGE_BOARD_CONFIG_KEY, options: { mode: "discrete" } }]);
  });

  it("commits a drag continuously with the options the gesture supplies", () => {
    const { session, commits, saved } = harness();
    const layer = session.addLayer({ kind: "highlight" });

    session.patchLayer(layer.id, { x: 0.5 }, { mode: "continuous", captureHistory: true });
    session.patchLayer(layer.id, { x: 0.6 }, { mode: "continuous", captureHistory: false });

    expect(commits.slice(1).map((commit) => commit.options)).toEqual([
      { mode: "continuous", captureHistory: true },
      { mode: "continuous", captureHistory: false },
    ]);
    expect(saved().layers[1].x).toBe(0.6);
  });

  it("re-validates every patch so a bad value never persists", () => {
    const { session, saved } = harness();
    const layer = session.addLayer({ kind: "shape", shape: "ellipse" });

    session.patchLayer(layer.id, { color: "not-a-color", strokeWidth: 99, width: -1, kind: "text", id: "hijack" });

    expect(saved().layers[1]).toMatchObject({ id: layer.id, kind: "shape", color: "#ff3b30", strokeWidth: 0.06, width: 0.004 });
  });

  it("invalidates the flattened image on any edit", () => {
    const { session, saved } = harness();
    session.addLayer({ kind: "redact" });
    session.recordRender(session.board, "assets/source.png", RENDERED);
    expect(saved().lastRenderedAsset).toEqual(RENDERED);

    session.patchLayer(session.selectedId!, { style: "solid" });

    expect(saved().lastRenderedAsset).toBeNull();
    expect(saved().sourceAssetPath).toBe("");
  });

  it("records the flattened image without a history entry or a redraw", () => {
    const { session, commits, onChange } = harness();
    session.addLayer({ kind: "redact" });
    onChange.mockClear();

    session.recordRender(session.board, "assets/source.png", RENDERED);

    expect(commits[commits.length - 1].options).toEqual({ mode: "discrete", captureHistory: false });
    expect(onChange).not.toHaveBeenCalled();
    expect(session.board.lastRenderedAsset).toEqual(RENDERED);
  });

  it("does not take a picture of an earlier state as the picture of this one", () => {
    const { session, saved } = harness();
    session.addLayer({ kind: "highlight" });
    const drawn = session.board;
    // Edited while the picture was still being produced.
    session.addLayer({ kind: "redact" });

    session.recordRender(drawn, "assets/source.png", RENDERED);

    expect(session.board.layers.map((layer) => layer.kind)).toEqual(["base", "highlight", "redact"]);
    expect(session.board.lastRenderedAsset).toBeNull();
    expect(saved().lastRenderedAsset).toBeNull();
  });

  it("drops the flattened image when an undo puts other layers under it", () => {
    const { session, store } = harness();
    session.addLayer({ kind: "redact" });
    const withBlur = (store[STUDIO_IMAGE_BOARD_CONFIG_KEY] as Record<string, StudioJsonValue>).layers;
    session.removeLayer(session.selectedId!);
    session.addLayer({ kind: "shape", shape: "arrow" });
    session.recordRender(session.board, "assets/source.png", RENDERED);

    // Studio's undo merges field by field: the layers go back, the render recorded since stays.
    const undone = {
      [STUDIO_IMAGE_BOARD_CONFIG_KEY]: {
        ...(store[STUDIO_IMAGE_BOARD_CONFIG_KEY] as Record<string, StudioJsonValue>),
        layers: withBlur,
      },
    };
    session.sync(undone);

    expect(session.board.layers.map((layer) => layer.kind)).toEqual(["base", "redact"]);
    expect(session.board.lastRenderedAsset).toBeNull();
  });

  it("leaves out an empty caption nobody is typing into", () => {
    const { session, store, commits } = harness();
    const caption = session.addLayer({ kind: "text", text: "" }, { mode: "discrete", captureHistory: false });
    expect(commits[commits.length - 1].options).toEqual({ mode: "discrete", captureHistory: false });
    const withEmptyCaption = { ...store };

    // Being typed into, it is a layer like any other.
    session.sync(withEmptyCaption, caption.id);
    expect(session.board.layers.map((layer) => layer.kind)).toEqual(["base", "text"]);

    // Brought back by an undo with nobody typing, it is not.
    session.removeLayer(caption.id, { mode: "discrete", captureHistory: false });
    expect(commits[commits.length - 1].options).toEqual({ mode: "discrete", captureHistory: false });
    session.sync(withEmptyCaption);
    expect(session.board.layers.map((layer) => layer.kind)).toEqual(["base"]);

    // Nor when the editor opens on a board that was left with one.
    expect(harness(withEmptyCaption).session.board.layers.map((layer) => layer.kind)).toEqual(["base"]);
  });

  it("duplicates beside the original and reorders within the stack", () => {
    const { session, saved } = harness();
    const first = session.addLayer({ kind: "highlight", x: 0.2, y: 0.2 });
    const copy = session.duplicateLayer(first.id)!;

    expect(copy.id).not.toBe(first.id);
    expect(copy.x).toBeCloseTo(0.23, 6);
    expect(session.selectedId).toBe(copy.id);

    session.reorderLayer(copy.id, "backward");
    expect(saved().layers.map((layer) => layer.id)).toEqual(["base", copy.id, first.id]);
    session.reorderLayer(copy.id, "backward");
    session.reorderLayer(copy.id, "backward");
    expect(saved().layers.map((layer) => layer.id)).toEqual([copy.id, "base", first.id]);
    // The node image is a layer like any other, but there is only ever one.
    expect(session.duplicateLayer("base")).toBeNull();
  });

  it("deletes the background for transparency and can put it back at the bottom", () => {
    const { session, saved } = harness();
    session.addLayer({ kind: "text", text: "sticker" });
    session.select("base");

    session.removeLayer("base");
    expect(saved().layers.map((layer) => layer.kind)).toEqual(["text"]);
    expect(session.selectedId).toBeNull();

    session.restoreBase();
    session.restoreBase();
    expect(saved().layers.map((layer) => layer.kind)).toEqual(["base", "text"]);
  });

  it("sets and clears the crop", () => {
    const { session, saved } = harness();

    session.setCrop({ x: -0.2, y: 0, width: 1.4, height: 1 });
    expect(saved().crop).toEqual({ x: -0.2, y: 0, width: 1.4, height: 1 });
    session.setCrop(null);
    expect(saved().crop).toBeNull();
  });

  it("clears the selection when a drawing tool is armed", () => {
    const { session, onChange } = harness();
    const layer = session.addLayer({ kind: "highlight" });
    expect(session.selectedLayer?.id).toBe(layer.id);
    onChange.mockClear();

    session.setTool("redact");
    session.setTool("redact");

    expect(session.selectedId).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("adopts an undo made outside the editor and keeps a still-valid selection", () => {
    const { session, store, onChange } = harness();
    const kept = session.addLayer({ kind: "highlight" });
    const snapshot = JSON.parse(JSON.stringify(store)) as Record<string, StudioJsonValue>;
    const gone = session.addLayer({ kind: "redact" });
    session.select(kept.id);
    onChange.mockClear();

    session.sync(snapshot);

    expect(session.board.layers.map((layer) => layer.id)).toEqual(["base", kept.id]);
    expect(session.selectedId).toBe(kept.id);
    expect(onChange).toHaveBeenCalledTimes(1);

    session.select(null);
    session.sync({ ...snapshot });
    expect(session.board.layers.some((layer) => layer.id === gone.id)).toBe(false);
  });

  it("does not redraw when only the render cache moved", () => {
    const { session, store, onChange } = harness();
    session.addLayer({ kind: "highlight" });
    session.recordRender(session.board, "assets/source.png", RENDERED);
    onChange.mockClear();

    session.sync(store);

    expect(onChange).not.toHaveBeenCalled();
    expect(session.board.lastRenderedAsset).toEqual(RENDERED);
  });
});
