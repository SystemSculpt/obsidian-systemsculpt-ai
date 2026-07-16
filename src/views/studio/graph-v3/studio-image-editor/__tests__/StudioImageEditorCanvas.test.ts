/** @jest-environment jsdom */

import {
  createEmptyStudioCaptionBoardState,
  createStudioCaptionBoardLabel,
} from "../../../../../studio/StudioCaptionBoardState";
import { StudioImageEditorCanvas } from "../StudioImageEditorCanvas";

function installObsidianDomHelpers(ownerWindow: Window): void {
  const source = HTMLElement.prototype as unknown as Record<string, unknown>;
  const target = ownerWindow.HTMLElement.prototype as unknown as Record<string, unknown>;
  for (const method of ["createDiv", "createEl", "empty", "setAttr"]) {
    target[method] = source[method];
  }
}

function dispatchPointer(
  ownerWindow: Window,
  target: EventTarget,
  type: string,
  options: { clientX: number; clientY: number; pointerId: number }
): void {
  const event = new ownerWindow.Event(type, { bubbles: true }) as Event & {
    clientX: number;
    clientY: number;
    pointerId: number;
  };
  Object.assign(event, options);
  target.dispatchEvent(event);
}

describe("StudioImageEditorCanvas", () => {
  afterEach(() => {
    document.body.empty();
    jest.restoreAllMocks();
  });

  it("binds interaction and keyboard behavior to the mounted popout realm", () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const ownerWindow = frame.contentWindow!;
    const ownerDocument = frame.contentDocument!;
    installObsidianDomHelpers(ownerWindow);
    const viewport = ownerDocument.createElement("div");
    const surface = ownerDocument.createElement("div");
    viewport.appendChild(surface);
    ownerDocument.body.appendChild(viewport);
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });

    const mainAddListener = jest.spyOn(window, "addEventListener");
    const popoutAddListener = jest.spyOn(ownerWindow, "addEventListener");
    const popoutRemoveListener = jest.spyOn(ownerWindow, "removeEventListener");
    const onPatchFrame = jest.fn();
    const onDeleteSelected = jest.fn();
    const label = createStudioCaptionBoardLabel({
      id: "label",
      text: "Popout",
      x: 0.2,
      y: 0.2,
      width: 0.4,
      height: 0.2,
    });
    const state = {
      ...createEmptyStudioCaptionBoardState(),
      labels: [label],
    };
    const canvas = new StudioImageEditorCanvas(
      viewport,
      surface,
      ownerWindow,
      "Image",
      {
        onSelect: jest.fn(),
        onPatchFrame,
        onDeleteSelected,
        resolveSelectionFrame: () => label,
      }
    );
    canvas.setSource({
      path: "image.png",
      src: "data:image/png;base64,AA==",
      width: 400,
      height: 200,
      statusMessage: "",
    });
    canvas.render(state, { kind: "label", id: label.id });

    expect(popoutAddListener).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(mainAddListener).not.toHaveBeenCalledWith("pointermove", expect.any(Function));
    const stage = surface.querySelector<HTMLElement>(".ss-studio-caption-board__stage")!;
    const labelEl = surface.querySelector<HTMLElement>(".ss-studio-caption-board__label")!;
    expect(stage.ownerDocument).toBe(ownerDocument);
    Object.defineProperty(stage, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 }),
    });

    dispatchPointer(ownerWindow, labelEl, "pointerdown", { clientX: 80, clientY: 40, pointerId: 4 });
    dispatchPointer(ownerWindow, ownerWindow, "pointermove", { clientX: 120, clientY: 60, pointerId: 4 });
    expect(onPatchFrame).toHaveBeenCalledWith(
      { kind: "label", id: label.id },
      expect.objectContaining({ x: expect.closeTo(0.3), y: expect.closeTo(0.3) }),
      { mode: "continuous", captureHistory: true }
    );

    ownerWindow.dispatchEvent(new ownerWindow.KeyboardEvent("keydown", { key: "Delete" }));
    expect(onDeleteSelected).toHaveBeenCalledTimes(1);
    canvas.destroy();
    expect(popoutRemoveListener).toHaveBeenCalledWith("pointermove", expect.any(Function));
  });
});
