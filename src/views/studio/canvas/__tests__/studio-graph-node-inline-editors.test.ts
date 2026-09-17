import {
  shouldSuppressNodeOutputPreview,
} from "../StudioGraphNodeInlineEditors";

describe("StudioGraphNodeInlineEditors node-kind policy", () => {
  it("only suppresses output preview for content-dominant nodes", () => {
    expect(shouldSuppressNodeOutputPreview("studio.text_generation")).toBe(true);
    expect(shouldSuppressNodeOutputPreview("studio.image_generation")).toBe(true);
    expect(shouldSuppressNodeOutputPreview("studio.json")).toBe(true);
    expect(shouldSuppressNodeOutputPreview("studio.media_ingest")).toBe(true);
    expect(shouldSuppressNodeOutputPreview("studio.dataset")).toBe(true);
    expect(shouldSuppressNodeOutputPreview("studio.terminal")).toBe(true);
    expect(shouldSuppressNodeOutputPreview("studio.audio_extract")).toBe(false);
  });
});
