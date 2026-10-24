/**
 * @jest-environment jsdom
 */
import { App, Notice, TFile } from "obsidian";
import {
  BulkTranscriptionConfirmModal,
  BulkTranscriptionProgressWidget,
} from "../BulkTranscriptionConfirmModal";
import { tryCopyToClipboard } from "../../utils/clipboard";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), Notice: jest.fn() }));
jest.mock("../../utils/clipboard", () => ({ tryCopyToClipboard: jest.fn(async () => true) }));

function createPendingFiles() {
  return [
    { file: new TFile({ path: "Inbox/first.wav", name: "first.wav" }) },
    { file: new TFile({ path: "Inbox/second.mp3", name: "second.mp3" }) },
    { file: new TFile({ path: "Inbox/third.m4a", name: "third.m4a" }) },
  ];
}

describe("BulkTranscriptionConfirmModal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("asks once in plain words and confirms the full audio file set exactly once", () => {
    const onConfirm = jest.fn();
    const onDefer = jest.fn();
    const pendingFiles = createPendingFiles();

    const modal = new BulkTranscriptionConfirmModal({
      app: new App(),
      pendingFiles,
      onConfirm,
      onDefer,
    });

    modal.open();

    expect(document.body.textContent).toContain(
      "Transcribe 3 audio files with SystemSculpt? Processing stops at the first error. Closing this window leaves the files waiting.",
    );
    expect(document.body.textContent).not.toContain("Skip all");
    expect(document.body.textContent).not.toContain("settings > workflow");
    expect(document.body.textContent).not.toContain("batches of 3");
    const footerButtons = [...document.querySelectorAll(".ss-modal__footer button")].map((button) => button.textContent);
    expect(footerButtons).toEqual(["Not now", "Transcribe 3 files"]);

    const processButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Transcribe 3 files")
    ) as HTMLButtonElement;
    processButton.click();
    processButton.click();

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(pendingFiles);
    expect(onDefer).not.toHaveBeenCalled();
  });

  it.each([
    ["Not now", () => (document.querySelector("[data-testid='bulk-transcribe.not-now']") as HTMLButtonElement).click()],
    ["the close button", () => (document.querySelector(".ss-modal__close-button") as HTMLButtonElement).click()],
    // Obsidian closes a modal on Escape.
    ["Escape", (modal: BulkTranscriptionConfirmModal) => modal.close()],
  ])("defers once on %s and never confirms", (_label, dismiss) => {
    const onConfirm = jest.fn();
    const onDefer = jest.fn();

    const modal = new BulkTranscriptionConfirmModal({
      app: new App(),
      pendingFiles: createPendingFiles(),
      onConfirm,
      onDefer,
    });

    modal.open();
    dismiss(modal);
    modal.close();

    expect(onDefer).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("uses a semantic minimize button and live progress status", () => {
    const plugin = { register: jest.fn() } as any;
    const widget = new BulkTranscriptionProgressWidget({
      plugin,
      totalFiles: 4,
    });

    const toggleButton = document.querySelector(".systemsculpt-progress-dismiss") as HTMLButtonElement;
    expect(toggleButton.tagName).toBe("BUTTON");
    expect(toggleButton.classList.contains("ss-button")).toBe(true);
    expect(toggleButton.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".systemsculpt-bulk-progress-widget")?.matches(
      '.ss-surface[data-ss-surface="transient"]',
    )).toBe(true);

    const status = document.querySelector(".systemsculpt-progress-status") as HTMLElement;
    const detail = document.querySelector(".systemsculpt-progress-detail") as HTMLElement;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(detail.textContent).toContain("0 / 4 complete");

    toggleButton.click();
    expect(toggleButton.getAttribute("aria-expanded")).toBe("false");
    expect(toggleButton.getAttribute("aria-label")).toBe("Expand");

    widget.close();
  });

  it("shows a copied error on its button and keeps the failed batch visible", async () => {
    const widget = new BulkTranscriptionProgressWidget({ plugin: { register: jest.fn() } as any, totalFiles: 2 });
    widget.markFailed({ status: "Transcription stopped", detailLines: ["second.mp3: Upload failed"], copyText: "second.mp3: Upload failed" });
    const copy = document.querySelector<HTMLButtonElement>('[data-testid="bulk-transcribe.progress.copy-error"]')!;

    copy.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(tryCopyToClipboard).toHaveBeenCalledWith("second.mp3: Upload failed", expect.any(HTMLElement));
    expect(copy.textContent).toContain("Copied");
    expect(document.body.textContent).toContain("second.mp3: Upload failed");
    expect(Notice).not.toHaveBeenCalled();
    widget.close();
  });
});
