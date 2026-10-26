/** @jest-environment jsdom */

import { App, Notice } from "obsidian";
import { BackupRestoreModal, BackupSelectionModal } from "../BackupRestoreModal";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), Notice: jest.fn() }));

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

describe("BackupRestoreModal.open", () => {
  let opened: BackupSelectionModal[] = [];
  beforeEach(() => {
    opened = [];
    const onOpen = BackupSelectionModal.prototype.onOpen;
    jest.spyOn(BackupSelectionModal.prototype, "onOpen").mockImplementation(function (this: BackupSelectionModal) {
      opened.push(this);
      onOpen.call(this);
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    document.body.empty();
    (Notice as unknown as jest.Mock).mockClear();
  });

  function createPicker() {
    const app = new App();
    const writes = new Map<string, string>();
    (app.vault.adapter.exists as jest.Mock).mockImplementation(async (path: string) =>
      path === ".systemsculpt/settings-backups" && writes.size > 0);
    (app.vault.adapter.list as jest.Mock).mockImplementation(async () => ({ files: [...writes.keys()], folders: [] }));
    (app.vault.adapter.read as jest.Mock).mockImplementation(async (path: string) => writes.get(path) ?? "");
    (app.vault.adapter.write as jest.Mock).mockImplementation(async (path: string, text: string) => {
      writes.set(path, text);
    });
    const plugin: any = {
      app,
      getSettingsManager: () => ({ getSettings: () => ({ chatFontSize: "large", licenseKey: "secret" }) }),
    };
    return { picker: new BackupRestoreModal(app, plugin), writes };
  }

  const flush = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("opens with an empty list and the manual backup form instead of a notice when no backups exist", async () => {
    const { picker } = createPicker();

    void picker.open();
    await flush();

    expect(opened).toHaveLength(1);
    const modal = opened[0].modalEl;
    expect(modal.querySelector(".ss-ui-state.is-empty")?.textContent).toContain("No backups found");
    expect(modal.querySelector("[data-testid='settings.backup.create-manual']")).not.toBeNull();
    expect(Notice).not.toHaveBeenCalled();
  });

  it("creates the first manual backup without a notice and lists it in the reopened picker", async () => {
    const { picker, writes } = createPicker();

    void picker.open();
    await flush();
    opened[0].modalEl.querySelector<HTMLButtonElement>("[data-testid='settings.backup.create-manual']")!.click();
    await flush();

    expect(writes.size).toBe(1);
    expect([...writes.values()][0]).not.toContain("secret");
    expect(opened).toHaveLength(2);
    expect(opened[1].modalEl.querySelector("[data-backup-path]")?.getAttribute("data-backup-path"))
      .toBe([...writes.keys()][0]);
    expect(Notice).not.toHaveBeenCalled();
  });
});

describe("BackupRestoreModal.restoreFromBackup", () => {
  const path = ".systemsculpt/settings-backups/latest.json";

  function createRestore(backupText: string | null) {
    const app = new App();
    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(backupText !== null);
    (app.vault.adapter.read as jest.Mock).mockResolvedValue(backupText ?? "");
    const restoreFromExternalSettings = jest.fn().mockResolvedValue(undefined);
    const plugin: any = {
      app,
      getSettingsManager: () => ({
        getSettings: () => ({ licenseKey: "current-license", phoneCapturesLinked: true, chatFontSize: "large" }),
        restoreFromExternalSettings,
      }),
    };
    return { restore: new BackupRestoreModal(app, plugin), restoreFromExternalSettings };
  }

  it("restores the backup's settings with the current credentials, not the redacted ones", async () => {
    const { restore, restoreFromExternalSettings } = createRestore(JSON.stringify({
      licenseKey: "",
      licenseValid: true,
      chatFontSize: "small",
    }));

    (Notice as unknown as jest.Mock).mockClear();
    await expect(restore.restoreFromBackup(path)).resolves.toBe(true);

    // The caller re-renders settings; a restore that worked needs no notice.
    expect(Notice).not.toHaveBeenCalled();
    expect(restoreFromExternalSettings).toHaveBeenCalledTimes(1);
    expect(restoreFromExternalSettings).toHaveBeenCalledWith(expect.objectContaining({
      licenseKey: "current-license",
      phoneCapturesLinked: true,
      chatFontSize: "small",
    }));
  });

  it.each([
    ["missing", null],
    ["not JSON", "{ truncated"],
    ["a list", "[]"],
    ["empty", "null"],
  ])("leaves settings untouched when the backup is %s", async (_label, backupText) => {
    const { restore, restoreFromExternalSettings } = createRestore(backupText);

    await expect(restore.restoreFromBackup(path)).resolves.toBe(false);

    expect(restoreFromExternalSettings).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalled();
  });
});
