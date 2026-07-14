/** @jest-environment jsdom */

import { App, TFile } from "obsidian";
import { ContextSelectionModal } from "../ContextSelectionModal";

function files(): TFile[] {
  return [
    new TFile({ path: "notes/meeting.md" }),
    new TFile({ path: "notes/project.md" }),
    new TFile({ path: "docs/readme.txt" }),
    new TFile({ path: "images/diagram.png" }),
    new TFile({ path: "images/photo.jpg" }),
    new TFile({ path: "documents/report.pdf" }),
    new TFile({ path: "documents/legacy.docx" }),
    new TFile({ path: "audio/recording.mp3" }),
  ];
}

function harness(options: ConstructorParameters<typeof ContextSelectionModal>[3] = {}) {
  const app = new App();
  (app.vault.getFiles as jest.Mock).mockReturnValue(files());
  const onSelect = jest.fn().mockResolvedValue(undefined);
  const modal = new ContextSelectionModal(app, onSelect, {}, options);
  modal.open();
  return { app, modal, onSelect };
}

describe("ContextSelectionModal", () => {
  afterEach(() => {
    jest.useRealTimers();
    document.body.empty();
  });

  it("uses the shared labelled dialog and only includes supported files", () => {
    const { modal } = harness({ autoFocusSearch: false });

    expect(modal.modalEl.classList.contains("ss-modal")).toBe(true);
    expect(modal.modalEl.getAttribute("role")).toBe("dialog");
    expect(modal.modalEl.textContent).toContain("Add context files");
    expect(modal.modalEl.textContent).not.toContain("legacy");
    expect(modal.modalEl.querySelectorAll(".ss-context-file-item")).toHaveLength(7);
  });

  it("applies initial filter, query, and selection", () => {
    const { modal } = harness({
      autoFocusSearch: false,
      initialFilter: "documents",
      initialSearchQuery: "report",
      initialSelectedPaths: ["documents/report.pdf"],
    });

    expect(modal.modalEl.querySelector<HTMLInputElement>(".ss-modal__search input[type='search']")?.value).toBe("report");
    const selectedFilter = modal.modalEl.querySelector(
      ".ss-context-filter-btn.is-selected",
    );
    expect(selectedFilter?.classList.contains("ss-button")).toBe(true);
    expect(selectedFilter?.textContent).toContain("Documents");
    expect(modal.modalEl.querySelectorAll(".ss-context-file-item")).toHaveLength(1);
    expect(modal.modalEl.querySelector<HTMLInputElement>('.ss-context-file-item input[type="checkbox"]')?.checked).toBe(true);
    expect(modal.modalEl.textContent).toContain("Add 1 file");
  });

  it("filters by type and search through semantic controls", () => {
    const { modal } = harness({ autoFocusSearch: false });
    const imageFilter = Array.from(modal.modalEl.querySelectorAll<HTMLButtonElement>(".ss-context-filter-btn"))
      .find((button) => button.textContent?.includes("Images"))!;
    imageFilter.click();
    expect(imageFilter.getAttribute("aria-pressed")).toBe("true");
    expect(modal.modalEl.querySelectorAll(".ss-context-file-item")).toHaveLength(2);

    const search = modal.modalEl.querySelector<HTMLInputElement>(".ss-modal__search input[type='search']")!;
    search.value = "diagram";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(modal.modalEl.querySelectorAll(".ss-context-file-item")).toHaveLength(1);
    expect(modal.modalEl.textContent).toContain("diagram");
  });

  it("uses native labelled checkboxes so keyboard focus and toggling update one selection state", () => {
    const { modal } = harness({ autoFocusSearch: false });
    const checkbox = modal.modalEl.querySelector<HTMLInputElement>('.ss-context-file-item input[type="checkbox"]')!;
    const label = checkbox.closest("label");

    expect(label).not.toBeNull();
    expect(checkbox.getAttribute("aria-label")).toContain("Add");
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);
    checkbox.click();
    expect(checkbox.checked).toBe(true);
    expect(modal.modalEl.textContent).toContain("Add 1 file");
    expect(checkbox.closest("li")?.classList.contains("is-selected")).toBe(true);
  });

  it("marks existing context as checked and immutable", () => {
    const { modal } = harness({
      autoFocusSearch: false,
      isFileAlreadyInContext: (file) => file.path === "notes/meeting.md",
    });
    const checkbox = Array.from(modal.modalEl.querySelectorAll<HTMLInputElement>('.ss-context-file-item input[type="checkbox"]'))
      .find((input) => input.getAttribute("aria-label")?.includes("meeting"))!;

    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.closest("li")?.classList.contains("is-attached")).toBe(true);
  });

  it("submits the selected files and closes", async () => {
    const { modal, onSelect } = harness({ autoFocusSearch: false });
    const checkbox = modal.modalEl.querySelector<HTMLInputElement>('.ss-context-file-item input[type="checkbox"]')!;
    checkbox.click();
    const add = Array.from(modal.modalEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Add 1 file")!;
    add.click();
    await Promise.resolve();

    expect(onSelect).toHaveBeenCalledWith([expect.objectContaining({ path: checkbox.closest("li")?.querySelector(".ss-context-file-path")?.textContent })]);
    expect(document.body.contains(modal.modalEl)).toBe(false);
  });

  it("keeps the dialog open and restores controls when adding fails", async () => {
    const { modal, onSelect } = harness({ autoFocusSearch: false });
    onSelect.mockRejectedValueOnce(new Error("Processing failed"));
    modal.modalEl.querySelector<HTMLInputElement>('.ss-context-file-item input[type="checkbox"]')!.click();
    Array.from(modal.modalEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Add 1 file")!
      .click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.body.contains(modal.modalEl)).toBe(true);
    expect(modal.modalEl.textContent).toContain("Add 1 file");
  });

  it("renders an honest empty state", () => {
    const { modal } = harness({ autoFocusSearch: false, initialSearchQuery: "missing-file" });
    expect(modal.modalEl.querySelector(".ss-context-empty")?.textContent).toContain("No files found");
  });

  it("renders large vaults in bounded batches", () => {
    const app = new App();
    (app.vault.getFiles as jest.Mock).mockReturnValue(
      Array.from({ length: 150 }, (_, index) => new TFile({ path: `notes/file-${index}.md` })),
    );
    const modal = new ContextSelectionModal(app, jest.fn(), {}, { autoFocusSearch: false });
    modal.open();

    expect(modal.modalEl.querySelectorAll(".ss-context-file-item")).toHaveLength(100);
    modal.modalEl.querySelector<HTMLButtonElement>(".ss-context-load-more")!.click();
    expect(modal.modalEl.querySelectorAll(".ss-context-file-item")).toHaveLength(150);
    expect(modal.modalEl.querySelector(".ss-context-load-more")).toBeNull();
  });

  it("focuses search by default and can opt out", () => {
    jest.useFakeTimers();
    const first = harness();
    jest.runOnlyPendingTimers();
    expect(document.activeElement).toBe(first.modal.modalEl.querySelector(".ss-modal__search input[type='search']"));

    first.modal.close();
    const second = harness({ autoFocusSearch: false });
    jest.runOnlyPendingTimers();
    expect(document.activeElement).not.toBe(second.modal.modalEl.querySelector(".ss-modal__search input[type='search']"));
  });
});
