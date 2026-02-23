import {
  hasStudioNodeInlineEditor,
  shouldSuppressNodeOutputPreview,
} from "../StudioGraphNodeInlineEditors";

describe("StudioGraphNodeInlineEditors node-kind policy", () => {
  it("enables inline editors for all Studio config node kinds", () => {
    expect(hasStudioNodeInlineEditor("studio.input")).toBe(true);
    expect(hasStudioNodeInlineEditor("studio.json")).toBe(true);
    expect(hasStudioNodeInlineEditor("studio.cli_command")).toBe(true);
    expect(hasStudioNodeInlineEditor("studio.http_request")).toBe(true);
    expect(hasStudioNodeInlineEditor("studio.dataset")).toBe(true);
    expect(hasStudioNodeInlineEditor("studio.media_ingest")).toBe(true);
    expect(hasStudioNodeInlineEditor("studio.audio_extract")).toBe(true);
    expect(hasStudioNodeInlineEditor("studio.text_generation")).toBe(true);
  });

  it("only suppresses output preview for content-dominant nodes", () => {
    expect(shouldSuppressNodeOutputPreview("studio.text_generation")).toBe(true);
    expect(shouldSuppressNodeOutputPreview("studio.image_generation")).toBe(true);
    expect(shouldSuppressNodeOutputPreview("studio.json")).toBe(true);
    expect(shouldSuppressNodeOutputPreview("studio.media_ingest")).toBe(true);
    expect(shouldSuppressNodeOutputPreview("studio.dataset")).toBe(true);
    expect(shouldSuppressNodeOutputPreview("studio.audio_extract")).toBe(false);
  });
});
