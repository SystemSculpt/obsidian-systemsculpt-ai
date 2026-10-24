/** @jest-environment jsdom */

import type { Workspace } from "obsidian";
import { observeLeafVisibility } from "../LeafVisibility";

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];
  target: Element | null = null;
  disconnect = jest.fn();
  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }
  observe(target: Element): void { this.target = target; }
  resize(width: number, height: number): void {
    this.callback([{ target: this.target, contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

describe("leaf visibility", () => {
  let root: HTMLElement;
  let shown: boolean;
  let hidden: boolean;
  let migrate: () => void;
  let dispose: () => void;
  let changed: jest.Mock;
  let listeners: Map<string, () => void>;
  let workspace: Workspace;
  const originalObserver = window.ResizeObserver;

  beforeEach(() => {
    ResizeObserverMock.instances = [];
    Object.defineProperty(window, "ResizeObserver", { configurable: true, value: ResizeObserverMock });
    shown = true;
    hidden = false;
    jest.spyOn(document, "visibilityState", "get").mockImplementation(() => hidden ? "hidden" : "visible");
    root = document.body.createDiv();
    root.isShown = () => shown;
    root.onWindowMigrated = callback => {
      migrate = () => callback(root.ownerDocument.defaultView!);
      return jest.fn();
    };
    listeners = new Map();
    workspace = {
      on: jest.fn((name: string, callback: () => void) => {
        listeners.set(name, callback);
        return name;
      }),
      offref: jest.fn((name: string) => listeners.delete(name)),
    } as unknown as Workspace;
    changed = jest.fn();
    dispose = observeLeafVisibility(root, workspace, changed);
  });

  afterEach(() => {
    dispose();
    document.body.replaceChildren();
    Object.defineProperty(window, "ResizeObserver", { configurable: true, value: originalObserver });
    jest.restoreAllMocks();
  });

  it("tracks hidden tabs in a visible document and reports only transitions", () => {
    expect(changed.mock.calls).toEqual([[true]]);
    shown = false;
    listeners.get("active-leaf-change")!();
    listeners.get("layout-change")!();
    expect(document.visibilityState).toBe("visible");
    expect(changed.mock.calls).toEqual([[true], [false]]);
    shown = true;
    listeners.get("layout-change")!();
    expect(changed.mock.calls).toEqual([[true], [false], [true]]);
  });

  it("keeps shown split panes rendering without requiring active leaf or window focus", () => {
    window.dispatchEvent(new Event("blur"));
    listeners.get("active-leaf-change")!();
    expect(changed.mock.calls).toEqual([[true]]);
    shown = false;
    window.dispatchEvent(new Event("focus"));
    expect(changed).toHaveBeenLastCalledWith(false);
  });

  it("suspends zero-size leaves and hidden documents until both become visible", () => {
    const observer = ResizeObserverMock.instances[0];
    observer.resize(0, 400);
    expect(changed).toHaveBeenLastCalledWith(false);
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    observer.resize(400, 400);
    expect(changed.mock.calls).toEqual([[true], [false]]);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(changed).toHaveBeenLastCalledWith(true);
  });

  it("observes an initially hidden leaf and rebinds to its pop-out owner", () => {
    dispose();
    shown = false;
    dispose = observeLeafVisibility(root, workspace, changed);
    expect(changed).toHaveBeenLastCalledWith(false);
    const oldObserver = ResizeObserverMock.instances.at(-1)!;
    const frame = document.body.createEl("iframe");
    const popout = frame.contentWindow!;
    Object.defineProperty(popout, "ResizeObserver", { configurable: true, value: ResizeObserverMock });
    jest.spyOn(popout.document, "visibilityState", "get").mockReturnValue("visible");
    popout.document.body.appendChild(root);
    shown = true;
    migrate();
    expect(oldObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith(true);
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(changed).toHaveBeenLastCalledWith(true);
    ResizeObserverMock.instances.at(-1)!.resize(0, 0);
    expect(changed).toHaveBeenLastCalledWith(false);
  });

  it("disconnects workspace, window, migration and observer callbacks on close", () => {
    dispose();
    expect(workspace.offref).toHaveBeenCalledTimes(2);
    expect(ResizeObserverMock.instances[0].disconnect).toHaveBeenCalledTimes(1);
    shown = false;
    window.dispatchEvent(new Event("focus"));
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(changed.mock.calls).toEqual([[true]]);
    dispose = () => {};
  });
});
