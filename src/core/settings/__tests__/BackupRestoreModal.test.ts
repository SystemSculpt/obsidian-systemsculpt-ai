/** @jest-environment jsdom */

import { App } from "obsidian";
import { BackupSelectionModal } from "../BackupRestoreModal";

const backups = [
  { path: ".systemsculpt/settings-backups/latest.json", name: "Latest backup", date: "Today", details: "Schema: 6" },
  { path: ".systemsculpt/settings-backups/older.json", name: "Older backup", date: "Yesterday" },
];

describe("BackupSelectionModal", () => {
  afterEach(() => document.body.empty());

  it("settles close and Escape cancellation with null", async () => {
    const modal = new BackupSelectionModal(new App(), backups);
    const selection = modal.openAndSelect();

    modal.close();

    await expect(selection).resolves.toBeNull();
  });

  it("returns the selected path when item activation closes the panel", async () => {
    const modal = new BackupSelectionModal(new App(), backups);
    const selection = modal.openAndSelect();

    modal.modalEl.querySelector<HTMLButtonElement>('[data-backup-path$="latest.json"]')?.click();
    modal.close();

    await expect(selection).resolves.toBe(backups[0].path);
  });

  it("keeps rich backup rows feature-owned", () => {
    const modal = new BackupSelectionModal(new App(), backups);
    modal.open();

    const row = modal.modalEl.querySelector<HTMLButtonElement>(
      '[data-backup-path$="latest.json"]',
    );
    expect(row?.classList.contains("ss-modal__item")).toBe(true);
    expect(row?.classList.contains("ss-button")).toBe(false);
    expect(row?.querySelector(".ss-modal__item-content")).not.toBeNull();
  });

  it("filters the focused backup list without async-search or multi-select machinery", () => {
    const modal = new BackupSelectionModal(new App(), backups);
    modal.open();
    const search = modal.modalEl.querySelector<HTMLInputElement>(".ss-modal__search input[type='search']")!;

    search.value = "older";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    const items = modal.modalEl.querySelectorAll<HTMLElement>("[data-backup-path]");
    expect(items).toHaveLength(1);
    expect(items[0].dataset.backupPath).toBe(backups[1].path);
  });

  it("uses the shared empty state when no backup matches", () => {
    const modal = new BackupSelectionModal(new App(), backups);
    modal.open();
    const search = modal.modalEl.querySelector<HTMLInputElement>(".ss-modal__search input[type='search']")!;

    search.value = "does not exist";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    const list = modal.modalEl.querySelector<HTMLElement>(".ss-modal__list")!;
    const state = list.querySelector<HTMLElement>(".ss-ui-state.is-empty");
    expect(list.getAttribute("role")).toBe("group");
    expect(state?.textContent).toContain("No matching backups");
    expect(state?.getAttribute("role")).toBe("status");
  });
});
