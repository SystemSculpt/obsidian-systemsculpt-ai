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
      title: "Move empty content to Trash",
      description: "8 empty items will move to Trash, following Obsidian’s trash setting.",
      groups: [
        {
          title: "Empty files (6)",
          items: Array.from({ length: 6 }, (_, index) => ({
            path: `Empty/file-${index}.md`,
            icon: "file-text",
          })),
          previewLimit: 5,
        },
        {
          title: "Empty folders (2)",
          items: [
            { path: "Empty/folder-one", icon: "folder" },
            { path: "Empty/folder-two", icon: "folder" },
          ],
          previewLimit: 5,
        },
        { title: "Nothing here (0)", items: [] },
      ],
    });

    const result = modal.openAndWait();

    expect(modal.modalEl.getAttribute("role")).toBe("dialog");
    expect(modal.modalEl.getAttribute("aria-labelledby")).toBeTruthy();
    expect(modal.modalEl.classList.contains("ss-modal--medium")).toBe(true);
    // Scrollable content carries the header's inset, so the rows align with the title.
    expect(modal.modalEl.classList.contains("ss-modal--scrollable")).toBe(true);
    const sections = [...modal.modalEl.querySelectorAll(".ss-janitor-preview-section")];
    expect(sections.map((section) => section.querySelector(".ss-janitor-preview-section-title")?.textContent))
      .toEqual(["Empty files (6)", "Empty folders (2)"]);
    expect(modal.modalEl.querySelectorAll(".ss-janitor-preview-item")).toHaveLength(7);
    expect(sections[0].querySelector(".ss-janitor-preview-more")?.textContent).toBe("and 1 more");
    expect(sections[1].querySelector(".ss-janitor-preview-more")).toBeNull();

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
        items: [{ path: "SystemSculpt/Chats/chat.md", icon: "file-text", detail: "2.0 KB" }],
      }],
    });

    const dismissed = createModal();
    const dismissedResult = dismissed.openAndWait();
    const flat = dismissed.modalEl.querySelector(".ss-janitor-preview-section")!;
    expect(flat.querySelector(".ss-janitor-preview-section-title")).toBeNull();
    expect(flat.querySelector(".ss-janitor-preview-size")?.textContent).toBe("2.0 KB");
    dismissed.close();
    await expect(dismissedResult).resolves.toBe(false);

    const cancelled = createModal();
    const cancelledResult = cancelled.openAndWait();
    findButton("Cancel").click();
    await expect(cancelledResult).resolves.toBe(false);
  });
});
