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

  it("filters the focused backup list without async-search or multi-select machinery", () => {
    const modal = new BackupSelectionModal(new App(), backups);
    modal.open();
    const search = modal.modalEl.querySelector<HTMLInputElement>(".ss-modal__search-input")!;

    search.value = "older";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    const items = modal.modalEl.querySelectorAll<HTMLElement>("[data-backup-path]");
    expect(items).toHaveLength(1);
    expect(items[0].dataset.backupPath).toBe(backups[1].path);
  });
});
