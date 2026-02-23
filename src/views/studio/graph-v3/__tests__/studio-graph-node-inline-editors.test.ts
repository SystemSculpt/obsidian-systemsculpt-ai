import {
  hasStudioNodeInlineEditor,
  shouldSuppressNodeOutputPreview,
} from "../StudioGraphNodeInlineEditors";

describe("StudioGraphNodeInlineEditors node-kind policy", () => {
  it("enables inline editors for migrated config nodes", () => {
    expect(hasStudioNodeInlineEditor("studio.media_ingest")).toBe(true);
    expect(hasStudioNodeInlineEditor("studio.audio_extract")).toBe(true);
    expect(hasStudioNodeInlineEditor("studio.text_generation")).toBe(true);
  });

  it("only suppresses output preview for content-dominant nodes", () => {
    expect(shouldSuppressNodeOutputPreview("studio.text_generation")).toBe(true);
    expect(shouldSuppressNodeOutputPreview("studio.image_generation")).toBe(true);
    expect(shouldSuppressNodeOutputPreview("studio.media_ingest")).toBe(true);
    expect(shouldSuppressNodeOutputPreview("studio.audio_extract")).toBe(false);
  });
});
