/**
 * @jest-environment jsdom
 */
import { EmbeddingsStatusBar } from "../EmbeddingsStatusBar";
import type { SemanticIndexSnapshot } from "../../services/embeddings/SemanticIndexLifecycle";

function snapshot(overrides: Partial<SemanticIndexSnapshot> = {}): SemanticIndexSnapshot {
  return {
    phase: "idle",
    ready: true,
    generation: { id: "semantic-v1", namespace: "managed:v2", dimensions: 3 },
    total: 12,
    completed: 12,
    pending: 0,
    failed: 0,
    currentPath: null,
    lastError: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function installObsidianDomHelpers(element: HTMLElement): void {
  (element as any).addClass = (...names: string[]) => element.classList.add(...names);
  (element as any).setAttr = (name: string, value: string) => element.setAttribute(name, value);
  (element as any).createSpan = (options: any = {}) => {
    const span = document.createElement("span");
    if (options.cls) span.className = options.cls;
    if (options.text) span.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) {
      span.setAttribute(name, String(value));
    }
    (span as any).setText = (value: string) => { span.textContent = value; };
    element.appendChild(span);
    return span;
  };
}

describe("EmbeddingsStatusBar", () => {
  let element: HTMLElement;
  let listener: ((value: SemanticIndexSnapshot) => void) | null;
  let unsubscribe: jest.Mock;
  let activateEmbeddingsView: jest.Mock;
  let plugin: any;
  let statusBar: EmbeddingsStatusBar;

  beforeEach(() => {
    element = document.createElement("div");
    document.body.appendChild(element);
    installObsidianDomHelpers(element);
    listener = null;
    unsubscribe = jest.fn();
    activateEmbeddingsView = jest.fn().mockResolvedValue(undefined);
    const manager = {
      getLifecycleSnapshot: jest.fn(() => snapshot()),
      subscribeLifecycle: jest.fn((next: (value: SemanticIndexSnapshot) => void) => {
        listener = next;
        next(snapshot());
        return unsubscribe;
      }),
    };
    plugin = {
      addStatusBarItem: jest.fn(() => element),
      settings: { embeddingsEnabled: true },
      embeddingsManager: manager,
      getViewManager: jest.fn(() => ({ activateEmbeddingsView })),
    };
    statusBar = new EmbeddingsStatusBar(plugin);
  });

  afterEach(() => {
    statusBar.onunload();
    document.body.innerHTML = "";
  });

  it("renders one accessible compact lifecycle projection", () => {
    expect(element.dataset.ssSurface).toBe("embedded");
    expect(element.getAttribute("role")).toBe("button");
    expect(element.getAttribute("aria-label")).toBe("Semantic index ready, 12 notes");
    expect(element.querySelector(".ss-embeddings-status-bar__value")?.textContent).toBe("12");
    expect(element.querySelector("progress")).toBeNull();
  });

  it("updates immediately from lifecycle snapshots without polling", () => {
    listener?.(snapshot({ phase: "reconciling", total: 20, completed: 7, pending: 13, currentPath: "Notes/Now.md" }));
    expect(element.querySelector(".ss-embeddings-status-bar__value")?.textContent).toBe("7/20");
    expect(element.title).toContain("Now.md");

    listener?.(snapshot({ phase: "error", failed: 2, lastError: { code: "managed", message: "Try again later." } }));
    expect(element.querySelector(".ss-embeddings-status-bar__value")?.textContent).toBe("2 failed");
    expect(element.title).toContain("Try again later");
  });

  it("opens the canonical Similar notes view with pointer or keyboard activation", () => {
    element.click();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(activateEmbeddingsView).toHaveBeenCalledTimes(3);
  });

  it("is absent while embeddings are disabled", () => {
    statusBar.onunload();
    const disabledElement = document.createElement("div");
    installObsidianDomHelpers(disabledElement);
    plugin.addStatusBarItem.mockReturnValue(disabledElement);
    plugin.settings.embeddingsEnabled = false;

    const disabled = new EmbeddingsStatusBar(plugin);
    expect(disabledElement.hidden).toBe(true);
    expect(disabledElement.getAttribute("aria-hidden")).toBe("");
    disabled.onunload();
  });

  it("rebinds exactly once and releases the lifecycle listener on unload", () => {
    statusBar.startMonitoring(plugin.embeddingsManager);
    expect(unsubscribe).not.toHaveBeenCalled();
    statusBar.onunload();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(element.isConnected).toBe(false);
  });
});
