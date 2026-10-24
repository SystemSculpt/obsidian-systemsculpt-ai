/** @jest-environment jsdom */

import { bindSurfaceActivity } from "../SurfaceActivity";

class IntersectionObserverMock {
  static instances: IntersectionObserverMock[] = [];
  root: Element | null = null;
  disconnect = jest.fn();
  constructor(private callback: IntersectionObserverCallback) {
    IntersectionObserverMock.instances.push(this);
  }
  observe(root: Element): void { this.root = root; }
  intersect(visible: boolean): void {
    this.callback([{ target: this.root, isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

describe("surface decorative activity", () => {
  let root: HTMLElement;
  let shown: boolean;
  let hidden: boolean;
  let dispose: () => void;
  let migrate: () => void;
  let detachMigration: jest.Mock;
  const originalObserver = window.IntersectionObserver;

  beforeEach(() => {
    IntersectionObserverMock.instances = [];
    Object.defineProperty(window, "IntersectionObserver", { configurable: true, value: IntersectionObserverMock });
    jest.spyOn(document, "hasFocus").mockReturnValue(true);
    hidden = false;
    jest.spyOn(document, "visibilityState", "get").mockImplementation(() => hidden ? "hidden" : "visible");
    shown = true;
    root = document.body.appendChild(document.createElement("div"));
    root.isShown = () => shown;
    detachMigration = jest.fn();
    root.onWindowMigrated = callback => {
      migrate = () => callback(root.ownerDocument.defaultView!);
      return detachMigration;
    };
    dispose = bindSurfaceActivity(root);
  });

  afterEach(() => {
    dispose();
    document.body.replaceChildren();
    Object.defineProperty(window, "IntersectionObserver", { configurable: true, value: originalObserver });
    jest.restoreAllMocks();
  });

  const paused = (root: HTMLElement) => root.classList.contains("ss-motion-paused");

  it("pauses a hidden leaf even while its document is visible, then resumes on show", () => {
    const observer = IntersectionObserverMock.instances[0];
    expect(paused(root)).toBe(false);
    shown = false;
    observer.intersect(false);
    expect(document.visibilityState).toBe("visible");
    expect(paused(root)).toBe(true);
    shown = true;
    observer.intersect(true);
    expect(paused(root)).toBe(false);
  });

  it("pauses offscreen surfaces without requiring the active-leaf predicate", () => {
    const observer = IntersectionObserverMock.instances[0];
    observer.intersect(false);
    expect(paused(root)).toBe(true);
    observer.intersect(true);
    expect(paused(root)).toBe(false);
  });

  it("requires both a visible document and focused owner window before resuming", () => {
    window.dispatchEvent(new Event("blur"));
    expect(paused(root)).toBe(true);
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    expect(paused(root)).toBe(true);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(paused(root)).toBe(false);
  });

  it("honors a leaf already hidden at bind time and does not resume it on focus", () => {
    dispose();
    shown = false;
    dispose = bindSurfaceActivity(root);
    expect(paused(root)).toBe(true);
    window.dispatchEvent(new Event("focus"));
    expect(paused(root)).toBe(true);
    shown = true;
    IntersectionObserverMock.instances.at(-1)!.intersect(true);
    expect(paused(root)).toBe(false);
  });

  it("rebinds visibility, focus and observers to a popout's owner document", () => {
    const oldObserver = IntersectionObserverMock.instances[0];
    const frame = document.body.appendChild(document.createElement("iframe"));
    const popout = frame.contentWindow!;
    Object.defineProperty(popout, "IntersectionObserver", { configurable: true, value: IntersectionObserverMock });
    jest.spyOn(popout.document, "hasFocus").mockReturnValue(true);
    jest.spyOn(popout.document, "visibilityState", "get").mockReturnValue("visible");
    popout.document.body.appendChild(root);
    migrate();
    expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(IntersectionObserverMock.instances.at(-1)!.root).toBe(root);
    window.dispatchEvent(new Event("blur"));
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(paused(root)).toBe(false);
    popout.dispatchEvent(new Event("blur"));
    expect(paused(root)).toBe(true);
    popout.dispatchEvent(new Event("focus"));
    expect(paused(root)).toBe(false);
    dispose();
    expect(IntersectionObserverMock.instances.at(-1)!.disconnect).toHaveBeenCalledTimes(1);
    dispose = () => {};
  });

  it("disconnects all lifecycle hooks on disposal", () => {
    dispose();
    expect(detachMigration).toHaveBeenCalledTimes(1);
    expect(IntersectionObserverMock.instances[0].disconnect).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("blur"));
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(paused(root)).toBe(false);
    dispose = () => {};
  });

  it("still gates document and owner-window activity without IntersectionObserver", () => {
    dispose();
    Object.defineProperty(window, "IntersectionObserver", { configurable: true, value: undefined });
    dispose = bindSurfaceActivity(root);
    window.dispatchEvent(new Event("blur"));
    expect(paused(root)).toBe(true);
    window.dispatchEvent(new Event("focus"));
    expect(paused(root)).toBe(false);
  });
});
