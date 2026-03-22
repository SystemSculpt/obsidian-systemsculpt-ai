/**
 * @jest-environment jsdom
 */
import type { App } from "obsidian";
import { readStudioCaptionBoardState } from "../../../../studio/StudioCaptionBoardState";
import type { StudioNodeDefinition, StudioNodeInstance } from "../../../../studio/types";
import type { StudioNodeRunDisplayState } from "../../StudioRunPresentationState";
import { openStudioImageEditorModal } from "../StudioGraphImageEditorModal";
import { renderStudioNodeInlineEditor } from "../StudioGraphNodeInlineEditors";

const IDLE_NODE_RUN_STATE: StudioNodeRunDisplayState = {
  status: "idle",
  message: "",
  updatedAt: null,
  outputs: null,
};

const PREVIEW_ASSET = {
  path: "Studio/assets/source.png",
  mimeType: "image/png",
  hash: "preview-hash",
  sizeBytes: 42,
};

const RENDERED_ASSET = {
  path: "Studio/assets/captioned.svg",
  mimeType: "image/svg+xml",
  hash: "rendered-hash",
  sizeBytes: 256,
};

function definitionFixture(kind: "studio.media_ingest" | "studio.image_generation"): StudioNodeDefinition {
  return {
    kind,
    version: "1.0.0",
    capabilityClass: kind === "studio.media_ingest" ? "local_io" : "api",
    cachePolicy: "by_inputs",
    inputPorts: [],
    outputPorts: kind === "studio.media_ingest" ? [{ id: "path", type: "text" }] : [{ id: "images", type: "json" }],
    configDefaults: kind === "studio.media_ingest" ? { sourcePath: "" } : { count: 1, aspectRatio: "16:9" },
    configSchema: {
      fields:
        kind === "studio.media_ingest"
          ? [{ key: "sourcePath", label: "Source Path", type: "media_path", required: true }]
          : [
              { key: "count", label: "Count", type: "number", required: true },
              { key: "aspectRatio", label: "Aspect Ratio", type: "select", required: false },
            ],
      allowUnknownKeys: true,
    },
    async execute() {
      return { outputs: {} };
    },
  };
}

function mediaNodeFixture(config: StudioNodeInstance["config"] = {}): StudioNodeInstance {
  return {
    id: "node_media",
    kind: "studio.media_ingest",
    version: "1.0.0",
    title: "Media",
    position: { x: 0, y: 0 },
    config,
    continueOnError: false,
    disabled: false,
  };
}

function imageNodeFixture(config: StudioNodeInstance["config"] = {}): StudioNodeInstance {
  return {
    id: "node_image",
    kind: "studio.image_generation",
    version: "1.0.0",
    title: "Image",
    position: { x: 0, y: 0 },
    config,
    continueOnError: false,
    disabled: false,
  };
}

function imageNodeRunState(): StudioNodeRunDisplayState {
  return {
    ...IDLE_NODE_RUN_STATE,
    outputs: {
      path: PREVIEW_ASSET.path,
      preview_path: PREVIEW_ASSET.path,
      preview_asset: PREVIEW_ASSET,
      source_preview_path: PREVIEW_ASSET.path,
      source_preview_asset: PREVIEW_ASSET,
    },
  };
}

function typeValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  element.value = value;
  const eventName = element.tagName === "SELECT" ? "change" : "input";
  element.dispatchEvent(new Event(eventName, { bubbles: true }));
}

function dispatchPointer(
  target: EventTarget,
  type: string,
  options: { clientX: number; clientY: number; pointerId?: number }
): void {
  const event = new Event(type, { bubbles: true }) as Event & {
    clientX: number;
    clientY: number;
    pointerId: number;
    preventDefault: () => void;
    stopPropagation: () => void;
  };
  event.clientX = options.clientX;
  event.clientY = options.clientY;
  event.pointerId = options.pointerId ?? 1;
  target.dispatchEvent(event);
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function setStageRect(stage: HTMLElement): void {
  Object.defineProperty(stage, "getBoundingClientRect", {
    value: () => ({
      left: 0,
      top: 0,
      width: 400,
      height: 200,
      right: 400,
      bottom: 200,
    }),
    configurable: true,
  });
}

function tinyPngBytes(): ArrayBuffer {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92,
    0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]).buffer;
}

describe("StudioGraphImageInlineEditor", () => {
  const RealImage = global.Image;

  beforeEach(() => {
    document.body.innerHTML = "";
    class MockImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 1200;
      naturalHeight = 800;

      set src(_value: string) {
        queueMicrotask(() => {
          this.onload?.();
        });
      }
    }
    global.Image = MockImage as unknown as typeof Image;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    global.Image = RealImage;
  });

  it("keeps image media-ingest inline editing focused on source-path config", () => {
    const nodeEl = document.createElement("div");
    const node = mediaNodeFixture({
      sourcePath: "Assets/source.png",
    });

    const rendered = renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: imageNodeRunState(),
      definition: definitionFixture("studio.media_ingest"),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
      onOpenImageEditor: jest.fn(),
    });

    expect(rendered).toBe(true);
    expect(nodeEl.querySelector(".ss-studio-node-inline-config")).not.toBeNull();
    expect(nodeEl.querySelector(".ss-studio-node-board-entry")).toBeNull();
  });

  it("keeps image generation nodes on the generic inline config", () => {
    const nodeEl = document.createElement("div");
    const node = imageNodeFixture({
      count: 2,
      aspectRatio: "1:1",
    });

    const rendered = renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture("studio.image_generation"),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    expect(rendered).toBe(true);
    expect(nodeEl.querySelector(".ss-studio-node-inline-config")).not.toBeNull();
    expect(nodeEl.querySelector(".ss-studio-node-board-entry")).toBeNull();
  });

  it("opens the caption board as a viewport + canvas + sidebar modal", async () => {
    const node = mediaNodeFixture({
      sourcePath: "Assets/source.png",
    });

    openStudioImageEditorModal({
      app: {} as App,
      node,
      nodeRunState: imageNodeRunState(),
      projectPath: "Studio/Test.systemsculpt",
      resolveAssetPreviewSrc: () => "app://preview",
      readAsset: jest.fn(async () => tinyPngBytes()),
      storeAsset: jest.fn(async () => RENDERED_ASSET),
      onNodeConfigMutated: jest.fn(),
    });
    await flushAsync();

    const modalEl = document.body.querySelector<HTMLElement>(".ss-studio-caption-board-modal-shell");
    expect(modalEl).not.toBeNull();
    expect(modalEl?.querySelector(".ss-studio-caption-board__toolbar")).not.toBeNull();
    expect(modalEl?.querySelector(".ss-studio-caption-board__viewport")).not.toBeNull();
    expect(modalEl?.querySelector(".ss-studio-caption-board__sidebar")).not.toBeNull();
    expect(modalEl?.querySelector(".ss-studio-caption-board__viewport textarea")).toBeNull();
  });

  it("adds, edits, drags, and resizes labels through the board UI", async () => {
    const node = mediaNodeFixture({
      sourcePath: "Assets/source.png",
      captionBoard: {
        version: 1,
        labels: [
          {
            id: "label-1",
            text: "Drag me",
            x: 0.2,
            y: 0.2,
            width: 0.4,
            height: 0.2,
            fontSize: 56,
            textAlign: "center",
            textColor: "#ffffff",
            styleVariant: "shadow",
            zIndex: 0,
          },
        ],
        sourceAssetPath: PREVIEW_ASSET.path,
        lastRenderedAsset: null,
        updatedAt: "2026-03-22T00:00:00.000Z",
      },
    });
    const onNodeConfigMutated = jest.fn();

    openStudioImageEditorModal({
      app: {} as App,
      node,
      nodeRunState: imageNodeRunState(),
      projectPath: "Studio/Test.systemsculpt",
      resolveAssetPreviewSrc: () => "app://preview",
      readAsset: jest.fn(async () => tinyPngBytes()),
      storeAsset: jest.fn(async () => RENDERED_ASSET),
      onNodeConfigMutated,
    });
    await flushAsync();

    const stage = document.body.querySelector<HTMLElement>(".ss-studio-caption-board__stage");
    expect(stage).not.toBeNull();
    setStageRect(stage!);

    const textInput = document.body.querySelector<HTMLTextAreaElement>(".ss-studio-caption-board__textarea");
    expect(textInput).not.toBeNull();
    typeValue(textInput!, "Updated headline");

    let label = document.body.querySelector<HTMLElement>(".ss-studio-caption-board__label.is-selected");
    expect(label).not.toBeNull();
    dispatchPointer(label!, "pointerdown", { clientX: 100, clientY: 60, pointerId: 7 });
    setStageRect(document.body.querySelector<HTMLElement>(".ss-studio-caption-board__stage")!);
    dispatchPointer(window, "pointermove", { clientX: 140, clientY: 80, pointerId: 7 });
    dispatchPointer(window, "pointerup", { clientX: 140, clientY: 80, pointerId: 7 });

    label = document.body.querySelector<HTMLElement>(".ss-studio-caption-board__label.is-selected");
    const resizeHandle = label?.querySelector<HTMLElement>(".ss-studio-caption-board__label-resize-handle");
    expect(resizeHandle).not.toBeNull();
    dispatchPointer(resizeHandle!, "pointerdown", { clientX: 300, clientY: 120, pointerId: 9 });
    setStageRect(document.body.querySelector<HTMLElement>(".ss-studio-caption-board__stage")!);
    dispatchPointer(window, "pointermove", { clientX: 340, clientY: 140, pointerId: 9 });
    dispatchPointer(window, "pointerup", { clientX: 340, clientY: 140, pointerId: 9 });

    const boardState = readStudioCaptionBoardState(node.config);
    expect(boardState.labels[0]?.text).toBe("Updated headline");
    expect(boardState.labels[0]?.x).toBeCloseTo(0.3, 2);
    expect(boardState.labels[0]?.y).toBeCloseTo(0.3, 2);
    expect(boardState.labels[0]?.width).toBeCloseTo(0.5, 2);
    expect(boardState.labels[0]?.height).toBeCloseTo(0.3, 2);
    expect(onNodeConfigMutated).toHaveBeenCalled();
  });

  it("adds callouts and crop controls through the editor UI", async () => {
    const node = mediaNodeFixture({
      sourcePath: "Assets/source.png",
    });
    const onNodeConfigMutated = jest.fn();

    openStudioImageEditorModal({
      app: {} as App,
      node,
      nodeRunState: imageNodeRunState(),
      projectPath: "Studio/Test.systemsculpt",
      resolveAssetPreviewSrc: () => "app://preview",
      readAsset: jest.fn(async () => tinyPngBytes()),
      storeAsset: jest.fn(async () => RENDERED_ASSET),
      onNodeConfigMutated,
    });
    await flushAsync();

    const stage = document.body.querySelector<HTMLElement>(".ss-studio-caption-board__stage");
    expect(stage).not.toBeNull();
    setStageRect(stage!);

    const redBoxButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Red Box"
    );
    const blurBoxButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Blur Box"
    );
    const addCropButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Add Crop"
    );
    expect(redBoxButton).toBeDefined();
    expect(blurBoxButton).toBeDefined();
    expect(addCropButton).toBeDefined();

    redBoxButton?.click();
    await flushAsync();

    let annotation = document.body.querySelector<HTMLElement>(
      ".ss-studio-caption-board__annotation.is-highlight_rect.is-selected"
    );
    expect(annotation).not.toBeNull();
    dispatchPointer(annotation!, "pointerdown", { clientX: 100, clientY: 60, pointerId: 11 });
    setStageRect(document.body.querySelector<HTMLElement>(".ss-studio-caption-board__stage")!);
    dispatchPointer(window, "pointermove", { clientX: 140, clientY: 80, pointerId: 11 });
    dispatchPointer(window, "pointerup", { clientX: 140, clientY: 80, pointerId: 11 });

    blurBoxButton?.click();
    await flushAsync();
    addCropButton?.click();
    await flushAsync();

    const crop = document.body.querySelector<HTMLElement>(".ss-studio-caption-board__crop.is-selected");
    expect(crop).not.toBeNull();
    const cropResizeHandle = crop?.querySelector<HTMLElement>(".ss-studio-caption-board__overlay-resize-handle");
    expect(cropResizeHandle).not.toBeNull();
    dispatchPointer(cropResizeHandle!, "pointerdown", { clientX: 320, clientY: 160, pointerId: 13 });
    setStageRect(document.body.querySelector<HTMLElement>(".ss-studio-caption-board__stage")!);
    dispatchPointer(window, "pointermove", { clientX: 360, clientY: 180, pointerId: 13 });
    dispatchPointer(window, "pointerup", { clientX: 360, clientY: 180, pointerId: 13 });

    const boardState = readStudioCaptionBoardState(node.config);
    expect(boardState.annotations).toHaveLength(2);
    expect(boardState.annotations[0]?.kind).toBe("highlight_rect");
    expect(boardState.annotations[0]?.x).toBeGreaterThan(0.35);
    expect(boardState.annotations[1]?.kind).toBe("blur_rect");
    expect(boardState.crop).not.toBeNull();
    expect(boardState.crop?.width).toBeGreaterThan(0.82);
    expect(onNodeConfigMutated).toHaveBeenCalled();
  });

  it("saves a rendered board asset on Done", async () => {
    const node = mediaNodeFixture({
      sourcePath: "Assets/source.png",
      captionBoard: {
        version: 1,
        labels: [
          {
            id: "label-1",
            text: "Quarterly update",
            x: 0.16,
            y: 0.14,
            width: 0.5,
            height: 0.2,
            fontSize: 56,
            textAlign: "center",
            textColor: "#ffffff",
            styleVariant: "banner",
            zIndex: 0,
          },
        ],
        sourceAssetPath: PREVIEW_ASSET.path,
        lastRenderedAsset: null,
        updatedAt: "2026-03-22T00:00:00.000Z",
      },
    });
    const onRenderedAssetCommitted = jest.fn();
    const readAsset = jest.fn(async () => tinyPngBytes());
    const storeAsset = jest.fn(async () => RENDERED_ASSET);

    openStudioImageEditorModal({
      app: {} as App,
      node,
      nodeRunState: imageNodeRunState(),
      projectPath: "Studio/Test.systemsculpt",
      resolveAssetPreviewSrc: () => "app://preview",
      readAsset,
      storeAsset,
      onNodeConfigMutated: jest.fn(),
      onRenderedAssetCommitted,
    });
    await flushAsync();

    const doneButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Done"
    );
    expect(doneButton).not.toBeUndefined();
    doneButton?.click();
    await flushAsync();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const boardState = readStudioCaptionBoardState(node.config);
    expect(readAsset).toHaveBeenCalledWith(PREVIEW_ASSET);
    expect(storeAsset).toHaveBeenCalledTimes(1);
    expect(storeAsset.mock.calls[0]?.[1]).toBe("image/svg+xml");
    expect(
      (storeAsset.mock.calls[0]?.[0] as ArrayBuffer | undefined)?.byteLength || 0
    ).toBeGreaterThan(0);
    expect(boardState.lastRenderedAsset).toEqual(RENDERED_ASSET);
    expect(onRenderedAssetCommitted).toHaveBeenCalledWith(node);
  });

  it("hydrates legacy single-caption config into board state", () => {
    const node = mediaNodeFixture({
      sourcePath: "Assets/source.png",
      captionText: "Legacy caption",
      captionNormalizedX: 0.5,
      captionNormalizedY: 0.24,
      captionFontSize: 60,
      captionAlignment: "right",
      captionTextColor: "#ffeeaa",
      captionStyleVariant: "outline",
    });

    const boardState = readStudioCaptionBoardState(node.config);
    expect(boardState.labels).toHaveLength(1);
    expect(boardState.labels[0]).toMatchObject({
      text: "Legacy caption",
      fontSize: 60,
      textAlign: "right",
      textColor: "#ffeeaa",
      styleVariant: "outline",
    });
  });
});
