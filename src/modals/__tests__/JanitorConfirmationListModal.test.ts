/** @jest-environment jsdom */

import { App } from "obsidian";
import {
  JanitorConfirmationListModal,
  formatJanitorFileSize,
  janitorFileIcon,
} from "../JanitorConfirmationListModal";

function findButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Missing ${label} button`);
  return button;
}

describe("JanitorConfirmationListModal", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shares file-size and file-icon presentation across Janitor surfaces", () => {
    expect(formatJanitorFileSize([])).toBe("empty");
    expect(formatJanitorFileSize([{ stat: { size: 12 } }])).toBe("12 bytes");
    expect(formatJanitorFileSize([{ stat: { size: 1024 } }])).toBe("1.0 KB");
    expect(formatJanitorFileSize([{ stat: { size: 1024 * 1024 } }])).toBe("1.0 MB");
    expect(formatJanitorFileSize([{ stat: { size: 1024 ** 3 } }])).toBe("1.0 GB");
    expect(janitorFileIcon("PDF")).toBe("file-text");
    expect(janitorFileIcon("png")).toBe("image");
    expect(janitorFileIcon("wav")).toBe("audio-lines");
    expect(janitorFileIcon("zip")).toBe("file");
  });

  it("renders one typed preview for flat and grouped cleanup confirmations", async () => {
    const modal = new JanitorConfirmationListModal(new App(), {
      title: "Move Empty Content to Trash",
      description: "8 empty items will move to Obsidian Trash. You can restore them later.",
      summary: "8 items",
      groups: [
        {
          title: "Empty Files",
          icon: "file-text",
          items: Array.from({ length: 6 }, (_, index) => ({
            path: `Empty/file-${index}.md`,
            icon: "file-text",
            detail: "empty",
          })),
          previewLimit: 5,
          moreLabel: "files",
        },
        {
          title: "Empty Folders",
          icon: "folder",
          items: [
            { path: "Empty/folder-one", icon: "folder" },
            { path: "Empty/folder-two", icon: "folder" },
          ],
          previewLimit: 5,
          moreLabel: "folders",
        },
      ],
    });

    const result = modal.open();

    expect(modal.modalEl.getAttribute("role")).toBe("dialog");
    expect(modal.modalEl.getAttribute("aria-labelledby")).toBeTruthy();
    expect(modal.modalEl.classList.contains("ss-modal--medium")).toBe(true);
    expect(modal.modalEl.querySelector(".ss-janitor-preview-count")?.textContent)
      .toBe("8 items");
    expect(modal.modalEl.querySelectorAll(".ss-janitor-preview-section")).toHaveLength(2);
    expect(modal.modalEl.querySelectorAll(".ss-janitor-preview-item")).toHaveLength(7);
    expect(modal.modalEl.textContent).toContain("Empty Files (6)");
    expect(modal.modalEl.textContent).toContain("... and 1 more files");
    expect(modal.modalEl.textContent).toContain("Empty Folders (2)");

    const confirm = findButton("Move to Trash");
    expect(confirm.classList.contains("ss-button--danger")).toBe(true);
    confirm.click();

    await expect(result).resolves.toBe(true);
    expect(modal.modalEl.isConnected).toBe(false);
  });

  it("resolves dismissal and cancel exactly once as declined", async () => {
    const createModal = () => new JanitorConfirmationListModal(new App(), {
      title: "Move chats to Trash",
      description: "One file will move to Obsidian Trash.",
      groups: [{
        items: [{ path: "SystemSculpt/Chats/chat.md", icon: "file-text" }],
        moreLabel: "files",
      }],
    });

    const dismissed = createModal();
    const dismissedResult = dismissed.open();
    dismissed.close();
    await expect(dismissedResult).resolves.toBe(false);

    const cancelled = createModal();
    const cancelledResult = cancelled.open();
    findButton("Cancel").click();
    await expect(cancelledResult).resolves.toBe(false);
  });
});
