import type { StudioJsonValue, StudioNodeInstance } from "../../../../../studio/types";
import { StudioImageEditorModel } from "../StudioImageEditorModel";

function nodeFixture(): StudioNodeInstance {
  return {
    id: "image-node",
    kind: "studio.media_ingest",
    version: "1.0.0",
    title: "Image",
    position: { x: 0, y: 0 },
    config: {
      captionBoard: {
        version: 1,
        labels: [
          {
            id: "first",
            text: "First",
            x: 0.1,
            y: 0.1,
            width: 0.3,
            height: 0.2,
            fontSize: 48,
            textAlign: "center",
            textColor: "#ffffff",
            styleVariant: "shadow",
            zIndex: 0,
          },
          {
            id: "second",
            text: "Second",
            x: 0.2,
            y: 0.2,
            width: 0.3,
            height: 0.2,
            fontSize: 48,
            textAlign: "center",
            textColor: "#ffffff",
            styleVariant: "shadow",
            zIndex: 1,
          },
        ],
        annotations: [],
        crop: null,
        sourceAssetPath: "",
        lastRenderedAsset: null,
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
    },
    continueOnError: false,
    disabled: false,
  };
}

describe("StudioImageEditorModel", () => {
  it("owns layer order and preserves explicit history mutation options", () => {
    const node = nodeFixture();
    const onNodeConfigValueChange = jest.fn(
      (_nodeId: string, key: string, value: StudioJsonValue) => {
        node.config[key] = value;
      }
    );
    const onChange = jest.fn();
    const model = new StudioImageEditorModel(
      {
        node,
        onNodeConfigMutated: jest.fn(),
        onNodeConfigValueChange,
      },
      onChange
    );

    model.select({ kind: "label", id: "first" });
    model.bumpSelected(1);

    expect(model.state.labels.map(({ id, zIndex }) => ({ id, zIndex }))).toEqual([
      { id: "second", zIndex: 0 },
      { id: "first", zIndex: 1 },
    ]);

    onNodeConfigValueChange.mockClear();
    model.patchSelectionFrame(
      { kind: "label", id: "first" },
      { x: 0.4 },
      { mode: "continuous", captureHistory: true }
    );
    expect(onNodeConfigValueChange).toHaveBeenLastCalledWith(
      node.id,
      "captionBoard",
      expect.any(Object),
      { mode: "continuous", captureHistory: true }
    );

    model.commitSavedState(model.state);
    expect(onNodeConfigValueChange).toHaveBeenLastCalledWith(
      node.id,
      "captionBoard",
      expect.any(Object),
      { mode: "discrete" }
    );
  });
});
