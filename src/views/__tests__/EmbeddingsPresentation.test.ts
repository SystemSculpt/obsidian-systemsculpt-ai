/**
 * @jest-environment jsdom
 */

import { SimilarNotesPresentation, type SimilarNotesPresentationActions } from "../SimilarNotesPresentation";
import type { SearchResult } from "../../services/embeddings/types";

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
    new SimilarNotesPresentation(root, createActions());

    expect(root.querySelector(".ss-embeddings-view__title")?.textContent).toBe("Similar notes");
    expect(root.querySelector('[aria-label="Refresh similar notes"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="Remaining embeddings"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="Embeddings settings"]')).not.toBeNull();
    expect(root.querySelector(".ss-embeddings-view__results")?.getAttribute("aria-live")).toBe("polite");
  });

  it("owns disabled and error actions behind one render interface", () => {
    const actions = createActions();
    const presentation = new SimilarNotesPresentation(root, actions);

    presentation.render({ state: "disabled" });
    expect(root.textContent).toContain("Embeddings are off");
    (root.querySelector(".ss-embeddings-view__state-actions button") as HTMLButtonElement).click();
    expect(actions.onOpenSettings).toHaveBeenCalledTimes(1);

    presentation.render({ state: "error", message: "Network unavailable" });
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

  it("renders bounded native progress with a compact current-file label", () => {
    const presentation = new SimilarNotesPresentation(root, createActions());
    presentation.render({ state: "processing" });
    presentation.updateProgress({ current: 12, total: 10, currentFile: "Projects/Current.md" });

    const progress = root.querySelector<HTMLProgressElement>(".ss-embeddings-view__progress");
    expect(progress?.value).toBe(100);
    expect(progress?.getAttribute("aria-valuetext")).toBe("100% complete");
    expect(root.querySelector(".ss-embeddings-view__progress-label")?.textContent).toBe("100% · Current.md");
  });

  it("keeps stale results visible while marking a refresh busy", () => {
    const presentation = new SimilarNotesPresentation(root, createActions());
    presentation.render({ state: "results", sourceName: "Current note", results: [result], chatContext: false });
    presentation.setRefreshing(true);

    expect(root.querySelector(".ss-similar-note")).not.toBeNull();
    expect(root.querySelector(".ss-embeddings-view__results")?.getAttribute("aria-busy")).toBe("true");
    expect(root.querySelector<HTMLButtonElement>('[aria-label="Refresh similar notes"]')?.disabled).toBe(true);
  });
});
