/**
 * @jest-environment jsdom
 */

import { setIcon } from "obsidian";
import { SimilarNotesPresentation, type SimilarNotesPresentationActions } from "../SimilarNotesPresentation";
import type { SearchResult } from "../../services/embeddings/types";
import type { SemanticIndexSnapshot } from "../../services/embeddings/SemanticIndexLifecycle";

function createActions(overrides: Partial<SimilarNotesPresentationActions> = {}): SimilarNotesPresentationActions {
  return {
    onRefresh: jest.fn(),
    onOpenSettings: jest.fn(),
    onOpenPendingFiles: jest.fn(),
    onStartProcessing: jest.fn(),
    onOpenFile: jest.fn(),
    onAddToContext: jest.fn(),
    onDragStateChange: jest.fn(),
    isInContext: jest.fn().mockReturnValue(false),
    ...overrides,
  };
}

const result: SearchResult = {
  path: "Projects/SystemSculpt.md",
  score: 0.876,
  metadata: {
    title: "SystemSculpt",
    excerpt: "A compact semantic result preview.",
    lastModified: Date.now() - 3_600_000,
    sectionTitle: "Architecture",
  },
};

function indexSnapshot(overrides: Partial<SemanticIndexSnapshot> = {}): SemanticIndexSnapshot {
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

describe("SimilarNotesPresentation", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.body.createDiv();
  });

  afterEach(() => {
    document.body.empty();
    jest.clearAllMocks();
  });

  it("builds a compact, labelled toolbar", () => {
    const presentation = new SimilarNotesPresentation(root, createActions());

    expect(presentation.element.matches('.ss-surface[data-ss-surface="view"]')).toBe(true);
    expect(root.querySelector(".ss-embeddings-view__title")?.textContent).toBe("Similar notes");
    expect(root.querySelector('[aria-label="Refresh similar notes"]')?.classList.contains("ss-button--icon")).toBe(true);
    expect(root.querySelector('[aria-label="Remaining embeddings"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="Embeddings settings"]')).not.toBeNull();
    expect(root.querySelector(".ss-embeddings-view__results")?.getAttribute("aria-live")).toBe("polite");
  });

  it("owns disabled and error actions behind one render interface", () => {
    const actions = createActions();
    const presentation = new SimilarNotesPresentation(root, actions);

    presentation.render({ state: "disabled" });
    expect(root.textContent).toContain("Embeddings are off");
    expect(root.querySelector(".ss-ui-state.is-empty")).not.toBeNull();
    (root.querySelector(".ss-embeddings-view__state-actions button") as HTMLButtonElement).click();
    expect(actions.onOpenSettings).toHaveBeenCalledTimes(1);

    presentation.render({ state: "error", message: "Network unavailable" });
    expect(root.querySelector(".ss-ui-state.is-error")).not.toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Network unavailable");
    (root.querySelector(".ss-embeddings-view__state-actions button") as HTMLButtonElement).click();
    expect(actions.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("never renders an empty Similar Notes error", () => {
    const presentation = new SimilarNotesPresentation(root, createActions());

    presentation.render({ state: "error", message: " \n\t " });

    const alert = root.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("Similar notes are unavailable. Try again.");
    expect(alert?.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("renders the canonical Obsidian icon for empty content", () => {
    const setIconMock = setIcon as jest.Mock;
    setIconMock.mockImplementation((element: HTMLElement, icon: string) => {
      if (icon !== "file-x") return;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("data-icon", icon);
      element.appendChild(svg);
    });

    try {
      const presentation = new SimilarNotesPresentation(root, createActions());
      presentation.render({ state: "empty-content" });

      expect(root.querySelector(
        '.ss-embeddings-view__state > .ss-ui-state__icon svg[data-icon="file-x"]',
      )).not.toBeNull();
    } finally {
      setIconMock.mockReset();
    }
  });

  it("renders a semantic list with one open link instead of an interactive row", () => {
    const actions = createActions();
    const presentation = new SimilarNotesPresentation(root, actions);

    presentation.render({ state: "results", sourceName: "Current note", results: [result], chatContext: false });

    const row = root.querySelector<HTMLElement>(".ss-similar-note");
    const link = root.querySelector<HTMLAnchorElement>(".ss-similar-note__title");
    expect(root.querySelector(".ss-embeddings-view__results-list")?.tagName).toBe("UL");
    expect(row?.tagName).toBe("LI");
    expect(row?.hasAttribute("tabindex")).toBe(false);
    expect(row?.hasAttribute("role")).toBe(false);
    expect(link?.getAttribute("aria-label")).toBe("Open SystemSculpt, 88% similar");
    expect(root.querySelector(".ss-similar-note__score")?.textContent).toBe("88%");
    expect(root.querySelector(".ss-similar-note__excerpt")?.textContent).toBe("A compact semantic result preview.");
    expect(root.querySelector(".ss-embeddings-view__context")?.textContent).toBe("Current note");
    expect(root.querySelector(".ss-embeddings-view__count")?.textContent).toBe("1");
    expect(root.querySelector(".ss-embeddings-view__count")?.getAttribute("aria-label"))
      .toBe("1 similar note");

    link?.click();
    expect(actions.onOpenFile).toHaveBeenCalledWith("Projects/SystemSculpt.md");
  });

  it("supports keyboard context addition and updates the in-context state", async () => {
    let inContext = false;
    const actions = createActions({
      isInContext: jest.fn(() => inContext),
      onAddToContext: jest.fn(async () => {
        inContext = true;
      }),
    });
    const presentation = new SimilarNotesPresentation(root, actions);

    presentation.render({ state: "results", sourceName: "Agent chat", results: [result], chatContext: true });
    const addButton = root.querySelector<HTMLButtonElement>(".ss-similar-note__context-action");
    expect(addButton?.getAttribute("aria-label")).toBe("Add SystemSculpt to chat context");

    addButton?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(actions.onAddToContext).toHaveBeenCalledWith("Projects/SystemSculpt.md");
    expect(root.querySelector(".ss-similar-note")?.classList.contains("is-in-context")).toBe(true);
    expect(addButton?.disabled).toBe(true);
    expect(addButton?.getAttribute("aria-label")).toBe("SystemSculpt is in chat context");
  });

  it("preserves the first-party drag payload and releases drag state", () => {
    const actions = createActions();
    const presentation = new SimilarNotesPresentation(root, actions);
    presentation.render({ state: "results", sourceName: "Agent chat", results: [result], chatContext: true });

    const row = root.querySelector<HTMLElement>(".ss-similar-note");
    const setData = jest.fn();
    const dataTransfer = { setData, effectAllowed: "none" };
    const dragStart = new Event("dragstart", { bubbles: true }) as DragEvent;
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    row?.dispatchEvent(dragStart);

    expect(setData).toHaveBeenCalledWith("text/plain", "Projects/SystemSculpt.md");
    expect(setData).toHaveBeenCalledWith(
      "application/x-systemsculpt-similar-note",
      expect.stringContaining('"source":"similar-notes"'),
    );
    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(actions.onDragStateChange).toHaveBeenCalledWith(true);

    row?.dispatchEvent(new Event("dragend", { bubbles: true }));
    expect(actions.onDragStateChange).toHaveBeenLastCalledWith(false);
  });

  it("owns drag timers in the Similar Notes popout realm", () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const foreignWindow = frame.contentWindow!;
    for (const helper of [
      "setText", "setAttr", "setAttrs", "empty", "createEl", "createDiv", "createSpan",
      "appendText", "addClass", "removeClass", "toggleClass", "hasClass", "toggle",
      "setCssStyles", "setCssProps", "hide", "show", "createFragment",
    ]) {
      (foreignWindow.HTMLElement.prototype as any)[helper] = (HTMLElement.prototype as any)[helper];
    }
    const foreignRoot = frame.contentDocument!.createElement("div");
    frame.contentDocument!.body.appendChild(foreignRoot);
    const foreignSetTimeout = jest.spyOn(foreignWindow, "setTimeout").mockReturnValue(91);
    const foreignClearTimeout = jest.spyOn(foreignWindow, "clearTimeout").mockImplementation(() => undefined);
    const mainSetTimeout = jest.spyOn(window, "setTimeout");
    const presentation = new SimilarNotesPresentation(foreignRoot, createActions());
    presentation.render({ state: "results", sourceName: "Agent chat", results: [result], chatContext: true });

    const row = foreignRoot.querySelector<HTMLElement>(".ss-similar-note")!;
    const dragStart = new Event("dragstart", { bubbles: true }) as DragEvent;
    Object.defineProperty(dragStart, "dataTransfer", {
      value: { setData: jest.fn(), effectAllowed: "none" },
    });
    row.dispatchEvent(dragStart);
    row.dispatchEvent(new Event("dragend", { bubbles: true }));

    expect(foreignSetTimeout).toHaveBeenCalledWith(expect.any(Function), 5_000);
    expect(foreignClearTimeout).toHaveBeenCalledWith(91);
    expect(mainSetTimeout).not.toHaveBeenCalled();
  });

  it("renders bounded native progress with a compact current-file label", () => {
    const presentation = new SimilarNotesPresentation(root, createActions());
    presentation.render({ state: "processing" });
    presentation.updateProgress({ current: 12, total: 10, currentFile: "Projects/Current.md" });

    const progress = root.querySelector<HTMLProgressElement>(".ss-embeddings-view__progress");
    expect(progress?.value).toBe(100);
    expect(progress?.getAttribute("aria-valuetext")).toBe("100% complete");
    expect(root.querySelector(".ss-embeddings-view__progress-label")?.textContent).toBe("100% · Current.md");
  });

  it("keeps the large processing pane out of the shared loading-spinner state", () => {
    const presentation = new SimilarNotesPresentation(root, createActions());

    presentation.render({ state: "processing" });

    expect(root.querySelector(".ss-embeddings-view__state--processing.is-info")).not.toBeNull();
    expect(root.querySelector(".ss-embeddings-view__state--processing.is-loading")).toBeNull();
  });

  it("keeps stale results visible while marking a refresh busy", () => {
    const presentation = new SimilarNotesPresentation(root, createActions());
    presentation.render({ state: "results", sourceName: "Current note", results: [result], chatContext: false });
    presentation.setRefreshing(true);

    expect(root.querySelector(".ss-similar-note")).not.toBeNull();
    expect(root.querySelector(".ss-embeddings-view__results")?.getAttribute("aria-busy")).toBe("true");
    expect(root.querySelector<HTMLButtonElement>('[aria-label="Refresh similar notes"]')?.disabled).toBe(true);
    expect(root.querySelector('[aria-label="Refresh similar notes"]')?.getAttribute("aria-busy")).toBe("true");
  });

  it("keeps lifecycle progress independent from current search results", () => {
    const presentation = new SimilarNotesPresentation(root, createActions());
    presentation.render({ state: "results", sourceName: "Current note", results: [result], chatContext: false });
    presentation.setIndexSnapshot(indexSnapshot({
      phase: "reconciling",
      total: 20,
      completed: 7,
      pending: 13,
      currentPath: "Notes/Current.md",
    }));

    expect(root.querySelector(".ss-similar-note")).not.toBeNull();
    expect(root.querySelector(".ss-embeddings-view__index-label")?.textContent).toBe("Indexing 7 of 20");
    expect(root.querySelector(".ss-embeddings-view__index-detail")?.textContent).toBe("Current.md");
    expect(root.querySelector<HTMLProgressElement>(".ss-embeddings-view__index-progress")?.value).toBe(7);

    presentation.setIndexSnapshot(indexSnapshot());
    expect(root.querySelector<HTMLElement>(".ss-embeddings-view__index-status")?.hidden).toBe(true);
  });

  it("clears stale lifecycle state when indexing is disabled", () => {
    const presentation = new SimilarNotesPresentation(root, createActions());
    presentation.setIndexSnapshot(indexSnapshot({
      phase: "reconciling",
      total: 20,
      completed: 7,
      pending: 13,
      currentPath: "Notes/Current.md",
    }));

    presentation.clearIndexSnapshot();

    const lifecycle = root.querySelector<HTMLElement>(".ss-embeddings-view__index-status");
    expect(lifecycle?.hidden).toBe(true);
    expect(lifecycle?.childElementCount).toBe(0);
    expect(lifecycle?.classList.contains("is-processing")).toBe(false);
  });

  it("routes lifecycle failures to the existing remaining-files workflow", () => {
    const actions = createActions();
    const presentation = new SimilarNotesPresentation(root, actions);
    presentation.setIndexSnapshot(indexSnapshot({
      phase: "error",
      failed: 2,
      lastError: { code: "managed", message: "Two notes could not be indexed." },
    }));

    expect(root.querySelector(".ss-embeddings-view__index-label")?.textContent).toBe("2 notes need attention");
    root.querySelector<HTMLButtonElement>("[data-index-action='pending']")?.click();
    expect(actions.onOpenPendingFiles).toHaveBeenCalledTimes(1);
  });
});
