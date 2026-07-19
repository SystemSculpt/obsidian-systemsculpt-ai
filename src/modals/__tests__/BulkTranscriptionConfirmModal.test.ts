/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";
import {
  BulkTranscriptionConfirmModal,
  BulkTranscriptionProgressWidget,
} from "../BulkTranscriptionConfirmModal";

function createPendingFiles() {
  return [
    { file: new TFile({ path: "Inbox/first.wav", name: "first.wav" }) },
    { file: new TFile({ path: "Inbox/second.mp3", name: "second.mp3" }) },
  ];
}

describe("BulkTranscriptionConfirmModal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("confirms the full audio file set without firing cancel", () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const pendingFiles = createPendingFiles();

    const modal = new BulkTranscriptionConfirmModal({
      app: new App(),
      pendingFiles,
      onConfirm,
      onCancel,
    });

    modal.open();

    expect(document.body.textContent).toContain("Bulk transcription detected");
    expect(document.body.textContent).toContain("2 transcriptions");
    expect(document.body.textContent).not.toContain("automation");

    const processButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Transcribe 2 files")
    ) as HTMLButtonElement;
    processButton.click();

    expect(onConfirm).toHaveBeenCalledWith(pendingFiles);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("treats dismiss as skip all", () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();

    const pendingFiles = createPendingFiles();
    const modal = new BulkTranscriptionConfirmModal({
      app: new App(),
      pendingFiles,
      onConfirm,
      onCancel,
    });

    modal.open();
    const closeButton = document.querySelector(".ss-modal__close-button") as HTMLButtonElement;
    closeButton.click();

    expect(onCancel).toHaveBeenCalledTimes(1);
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
});
