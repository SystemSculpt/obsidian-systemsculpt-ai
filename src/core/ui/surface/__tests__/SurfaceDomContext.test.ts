/** @jest-environment jsdom */

import {
  cancelSurfaceAnimationFrame,
  createSurfaceElement,
  createSurfaceFragment,
  getSurfaceOwnerDocument,
  getSurfaceOwnerWindow,
  requestSurfaceAnimationFrame,
  resolveSurfaceDomContext,
} from "../SurfaceDomContext";

describe("SurfaceDomContext", () => {
  afterEach(() => document.body.empty());

  it("follows a mounted surface into its owning iframe realm", () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const foreignDocument = frame.contentDocument!;
    const foreignWindow = frame.contentWindow!;
    const host = foreignDocument.createElement("div");
    foreignDocument.body.appendChild(host);

    expect(getSurfaceOwnerDocument(host)).toBe(foreignDocument);
    expect(getSurfaceOwnerWindow(host)).toBe(foreignWindow);
    expect(resolveSurfaceDomContext(host)).toEqual({
      host,
      document: foreignDocument,
      window: foreignWindow,
    });
  });

  it("requests and cancels animation in the owner realm", () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const host = frame.contentDocument!.body;
    const foreignWindow = frame.contentWindow!;
    const request = jest.spyOn(foreignWindow, "requestAnimationFrame").mockReturnValue(42);
    const cancel = jest.spyOn(foreignWindow, "cancelAnimationFrame").mockImplementation(() => undefined);
    const callback = jest.fn();

    expect(requestSurfaceAnimationFrame(host, callback)).toBe(42);
    cancelSurfaceAnimationFrame(host, 42);

    expect(request).toHaveBeenCalledWith(callback);
    expect(cancel).toHaveBeenCalledWith(42);
  });

  it("creates elements and fragments in a plain foreign document", () => {
    const foreignDocument = document.implementation.createHTMLDocument("Obsidian popout");

    const element = createSurfaceElement(foreignDocument, "template");
    const fragment = createSurfaceFragment(foreignDocument);

    expect(element.ownerDocument).toBe(foreignDocument);
    expect(fragment.ownerDocument).toBe(foreignDocument);
  });
});
