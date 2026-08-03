/** @jest-environment jsdom */

import { App, Notice, TFile } from "obsidian";
import { ContextSelectionModal } from "../ContextSelectionModal";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return { ...actual, Notice: jest.fn() };
});

const mockedNotice = Notice as unknown as jest.Mock;

function files(): TFile[] {
  return [
    new TFile({ path: "notes/meeting.md" }),
    new TFile({ path: "notes/project.md" }),
    new TFile({ path: "docs/readme.txt" }),
    new TFile({ path: "studio/architecture.systemsculpt" }),
    new TFile({ path: "images/diagram.png" }),
    new TFile({ path: "images/photo.jpg" }),
    new TFile({ path: "images/vector.svg" }),
    new TFile({ path: "documents/report.pdf" }),
    new TFile({ path: "documents/legacy.docx" }),
    new TFile({ path: "audio/recording.mp3" }),
  ];
}

function harness(
  options: ConstructorParameters<typeof ContextSelectionModal>[3] = {},
  getResourcePath: (file: TFile) => string = (file) =>
    `app://local/${encodeURIComponent(file.path)}`,
) {
  const app = new App();
  (app.vault.getFiles as jest.Mock).mockReturnValue(files());
  (app.vault as any).readBinary = jest.fn();
  (app.vault as any).getResourcePath = jest.fn(getResourcePath);
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
    expect(modal.modalEl.textContent).toContain("Pin files for every message");
    expect(modal.modalEl.textContent).toContain(
      "Files SystemSculpt reads while working remain part of this chat, but are not pinned automatically.",
    );
    expect(modal.modalEl.textContent).not.toContain("legacy");
    expect(modal.modalEl.textContent).not.toContain("vector");
    expect(modal.modalEl.querySelectorAll(".ss-context-file-item")).toHaveLength(8);
    expect(modal.modalEl.textContent).toContain("architecture");
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
    expect(modal.modalEl.textContent).toContain("Pin 1 file");
  });

  it("filters by type and search through semantic controls", () => {
    const { modal } = harness({ autoFocusSearch: false });
    const imageFilter = Array.from(modal.modalEl.querySelectorAll<HTMLButtonElement>(".ss-context-filter-btn"))
      .find((button) => button.textContent?.includes("Images"))!;
    imageFilter.click();
    expect(imageFilter.getAttribute("aria-pressed")).toBe("true");
    expect(modal.modalEl.querySelectorAll(".ss-context-file-item")).toHaveLength(2);
    expect(modal.modalEl.textContent).not.toContain("vector");

    const search = modal.modalEl.querySelector<HTMLInputElement>(".ss-modal__search input[type='search']")!;
    search.value = "diagram";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(modal.modalEl.querySelectorAll(".ss-context-file-item")).toHaveLength(1);
    expect(modal.modalEl.textContent).toContain("diagram");
  });

  it("shows lazy local thumbnails for supported vault images", () => {
    const { app, modal } = harness({ autoFocusSearch: false, initialFilter: "images" });
    const thumbnails = Array.from(
      modal.modalEl.querySelectorAll<HTMLImageElement>(".ss-context-file-thumbnail img"),
    );

    expect(thumbnails).toHaveLength(2);
    expect(thumbnails[0]?.src).toContain(encodeURIComponent("images/diagram.png"));
    expect(thumbnails[0]?.alt).toBe("");
    expect(thumbnails[0]?.loading).toBe("lazy");
    expect(thumbnails[0]?.decoding).toBe("async");
    expect(thumbnails[0]?.draggable).toBe(false);
    expect((app.vault as any).getResourcePath).toHaveBeenCalledTimes(2);
    expect((app.vault as any).getResourcePath).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "images/vector.svg" }),
    );
    expect(app.vault.readBinary).not.toHaveBeenCalled();
  });

  it.each([
    ["returns no URL", () => ""],
    ["throws", () => {
      throw new Error("resource unavailable");
    }],
  ])("uses the image fallback when resource lookup %s", (_label, getResourcePath) => {
    const { modal } = harness(
      { autoFocusSearch: false, initialFilter: "images" },
      getResourcePath,
    );
    const thumbnails = modal.modalEl.querySelectorAll(".ss-context-file-thumbnail");

    expect(thumbnails).toHaveLength(2);
    expect(Array.from(thumbnails).every((thumbnail) =>
      thumbnail.classList.contains("is-unavailable"))).toBe(true);
    expect(modal.modalEl.querySelectorAll(".ss-context-file-thumbnail img")).toHaveLength(0);
    expect(Array.from(modal.modalEl.querySelectorAll<HTMLInputElement>(
      '.ss-context-file-item input[type="checkbox"]',
    )).every((checkbox) => !checkbox.disabled)).toBe(true);
  });

  it("keeps a selectable image row when its thumbnail cannot load", () => {
    const { modal } = harness({ autoFocusSearch: false, initialFilter: "images" });
    const thumbnail = modal.modalEl.querySelector<HTMLElement>(".ss-context-file-thumbnail")!;
    const image = thumbnail.querySelector<HTMLImageElement>("img")!;
    image.dispatchEvent(new Event("error"));

    expect(thumbnail.classList.contains("is-unavailable")).toBe(true);
    expect(thumbnail.querySelector("img")).toBeNull();
    expect(thumbnail.closest("label")?.querySelector<HTMLInputElement>("input")?.disabled).toBe(false);
  });

  it("keeps thumbnail clicks owned by the native labelled checkbox", () => {
    const { modal } = harness({ autoFocusSearch: false, initialFilter: "images" });
    const thumbnail = modal.modalEl.querySelector<HTMLElement>(".ss-context-file-thumbnail")!;
    const checkbox = thumbnail.closest("label")?.querySelector<HTMLInputElement>("input")!;

    thumbnail.click();

    expect(checkbox.checked).toBe(true);
    expect(modal.modalEl.textContent).toContain("Pin 1 file");
    expect(checkbox.closest("li")?.classList.contains("is-selected")).toBe(true);
  });

  it("uses native labelled checkboxes so keyboard focus and toggling update one selection state", () => {
    const { modal } = harness({ autoFocusSearch: false });
    const checkbox = modal.modalEl.querySelector<HTMLInputElement>('.ss-context-file-item input[type="checkbox"]')!;
    const label = checkbox.closest("label");

    expect(label).not.toBeNull();
    expect(checkbox.getAttribute("aria-label")).toBe("Pin studio/architecture.systemsculpt");
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);
    checkbox.click();
    expect(checkbox.checked).toBe(true);
    expect(modal.modalEl.textContent).toContain("Pin 1 file");
    expect(checkbox.closest("li")?.classList.contains("is-selected")).toBe(true);
  });

  it("marks existing context as checked and immutable", () => {
    const { modal } = harness({
      autoFocusSearch: false,
      isFileAlreadyPinned: (file) => file.path === "notes/meeting.md",
    });
    const checkbox = Array.from(modal.modalEl.querySelectorAll<HTMLInputElement>('.ss-context-file-item input[type="checkbox"]'))
      .find((input) => input.getAttribute("aria-label")?.includes("meeting"))!;

    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.getAttribute("aria-label")).toBe(
      "notes/meeting.md, pinned for every message",
    );
    expect(checkbox.closest("li")?.classList.contains("is-pinned")).toBe(true);
    expect(checkbox.closest("li")?.textContent).toContain("Pinned");
  });

  it("submits the selected files and closes", async () => {
    const { modal, onSelect } = harness({ autoFocusSearch: false });
    const checkbox = modal.modalEl.querySelector<HTMLInputElement>('.ss-context-file-item input[type="checkbox"]')!;
    checkbox.click();
    const add = Array.from(modal.modalEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Pin 1 file")!;
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
      .find((button) => button.textContent === "Pin 1 file")!
      .click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.body.contains(modal.modalEl)).toBe(true);
    expect(modal.modalEl.textContent).toContain("Pin 1 file");
    expect(mockedNotice).toHaveBeenCalledWith(
      "Couldn't pin files for every message. Processing failed",
      5000,
    );
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

  it("only resolves thumbnails for each rendered image batch", () => {
    const app = new App();
    (app.vault.getFiles as jest.Mock).mockReturnValue(
      Array.from({ length: 150 }, (_, index) => new TFile({ path: `images/file-${index}.png` })),
    );
    (app.vault as any).getResourcePath = jest.fn(
      (file: TFile) => `app://local/${encodeURIComponent(file.path)}`,
    );
    const modal = new ContextSelectionModal(app, jest.fn(), {}, {
      autoFocusSearch: false,
      initialFilter: "images",
    });
    modal.open();

    expect((app.vault as any).getResourcePath).toHaveBeenCalledTimes(100);
    expect(modal.modalEl.querySelectorAll(".ss-context-file-thumbnail img")).toHaveLength(100);
    modal.modalEl.querySelector<HTMLButtonElement>(".ss-context-load-more")!.click();
    expect((app.vault as any).getResourcePath).toHaveBeenCalledTimes(150);
    expect(modal.modalEl.querySelectorAll(".ss-context-file-thumbnail img")).toHaveLength(150);
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
