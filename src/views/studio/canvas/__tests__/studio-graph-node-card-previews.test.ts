/** @jest-environment jsdom */

import type { StudioNodeInstance } from "../../../../studio/types";
import type { StudioNodeRunDisplayState } from "../../StudioRunPresentationState";
import { renderNodeMediaPreview } from "../StudioGraphNodeCardPreviews";

const mockHasHostCapability = jest.fn();
jest.mock("../../../../platform/hostCapabilities", () => ({
  hasHostCapability: (...args: unknown[]) => mockHasHostCapability(...args),
}));

const node: StudioNodeInstance = {
  id: "media",
  kind: "studio.media_ingest",
  version: "1.0.0",
  title: "Photo",
  position: { x: 0, y: 0 },
  config: { sourcePath: "Media/photo.png" },
};

const nodeRunState: StudioNodeRunDisplayState = {
  status: "succeeded",
  message: "",
  updatedAt: null,
  outputs: {
    path: "Media/photo.png",
    preview_path: "SystemSculpt/Studio/assets/photo.png",
  },
};

describe("Studio media preview host actions", () => {
  afterEach(() => {
    mockHasHostCapability.mockReset();
    document.body.replaceChildren();
  });

  it("offers file-manager reveal only when the host declares that capability", () => {
    mockHasHostCapability.mockReturnValue(true);
    const onRevealPathInFinder = jest.fn();
    const onOpenMediaPreview = jest.fn();

    renderNodeMediaPreview({
      nodeEl: document.body,
      node,
      nodeRunState,
      resolveAssetPreviewSrc: () => "app://local/photo.png",
      onRevealPathInFinder,
      onOpenMediaPreview,
    });
    const preview = document.body.querySelector<HTMLElement>(
      ".ss-studio-node-media-preview",
    )!;

    expect(preview.title).toBe("Double-click to reveal in file manager");
    preview.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    expect(onRevealPathInFinder).toHaveBeenCalledWith("Media/photo.png");
    expect(onOpenMediaPreview).not.toHaveBeenCalled();
  });

  it("opens the portable media preview instead of exposing a dead desktop action", () => {
    mockHasHostCapability.mockReturnValue(false);
    const onRevealPathInFinder = jest.fn();
    const onOpenMediaPreview = jest.fn();

    renderNodeMediaPreview({
      nodeEl: document.body,
      node,
      nodeRunState,
      resolveAssetPreviewSrc: () => "app://local/photo.png",
      onRevealPathInFinder,
      onOpenMediaPreview,
    });
    const preview = document.body.querySelector<HTMLElement>(
      ".ss-studio-node-media-preview",
    )!;

    expect(preview.hasAttribute("title")).toBe(false);
    preview.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    expect(onRevealPathInFinder).not.toHaveBeenCalled();
    expect(onOpenMediaPreview).toHaveBeenCalledWith({
      kind: "image",
      path: "SystemSculpt/Studio/assets/photo.png",
      src: "app://local/photo.png",
      title: "Photo",
    });
  });
});
