import { App, TFolder } from "obsidian";
import { createVaultFolder, isVaultFolder } from "../vaultFolders";

describe("createVaultFolder", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);
    (app.vault.adapter.stat as jest.Mock).mockResolvedValue(null);
  });

  it("creates a missing folder without consulting the adapter", async () => {
    (app.vault.createFolder as jest.Mock).mockResolvedValue(undefined);

    await createVaultFolder(app, "Notes/Inbox");

    expect(app.vault.createFolder).toHaveBeenCalledWith("Notes/Inbox");
    expect(app.vault.adapter.exists).not.toHaveBeenCalled();
  });

  it("accepts a folder the vault tree resolves after the rejection", async () => {
    (app.vault.createFolder as jest.Mock).mockRejectedValue(new Error("Folder already exists."));
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(new TFolder({ path: "Notes" }));

    await expect(createVaultFolder(app, "Notes")).resolves.toBeUndefined();
    expect(app.vault.adapter.exists).not.toHaveBeenCalled();
  });

  it("accepts a folder that exists only on disk (unindexed or hidden)", async () => {
    (app.vault.createFolder as jest.Mock).mockRejectedValue(new Error("Folder already exists."));
    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (app.vault.adapter.stat as jest.Mock).mockResolvedValue({ type: "folder", ctime: 0, mtime: 0, size: 0 });

    await expect(createVaultFolder(app, ".systemsculpt/settings-backups")).resolves.toBeUndefined();
    expect(app.vault.adapter.exists).toHaveBeenCalledWith(".systemsculpt/settings-backups");
  });

  it("rethrows the original error when nothing or a file is at the path", async () => {
    const failure = new Error("permission denied");
    (app.vault.createFolder as jest.Mock).mockRejectedValue(failure);

    await expect(createVaultFolder(app, "Locked")).rejects.toBe(failure);

    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (app.vault.adapter.stat as jest.Mock).mockResolvedValue({ type: "file", ctime: 0, mtime: 0, size: 1 });
    await expect(createVaultFolder(app, "Locked")).rejects.toBe(failure);
  });

  it("rethrows the original error when the adapter cannot confirm the folder", async () => {
    const failure = new Error("Folder already exists.");
    (app.vault.createFolder as jest.Mock).mockRejectedValue(failure);
    (app.vault.adapter.exists as jest.Mock).mockRejectedValue(new Error("adapter offline"));

    await expect(createVaultFolder(app, "Notes")).rejects.toBe(failure);
  });
});

describe("isVaultFolder", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);
    (app.vault.adapter.stat as jest.Mock).mockResolvedValue(null);
  });

  it("confirms a folder from the vault tree or, failing that, the adapter", async () => {
    await expect(isVaultFolder(app, "Notes")).resolves.toBe(false);

    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (app.vault.adapter.stat as jest.Mock).mockResolvedValue({ type: "file", ctime: 0, mtime: 0, size: 1 });
    await expect(isVaultFolder(app, "Notes")).resolves.toBe(false);

    (app.vault.adapter.stat as jest.Mock).mockResolvedValue({ type: "folder", ctime: 0, mtime: 0, size: 0 });
    await expect(isVaultFolder(app, "Notes")).resolves.toBe(true);

    (app.vault.adapter.exists as jest.Mock).mockRejectedValue(new Error("adapter offline"));
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(new TFolder({ path: "Notes" }));
    await expect(isVaultFolder(app, "Notes")).resolves.toBe(true);
  });
});
