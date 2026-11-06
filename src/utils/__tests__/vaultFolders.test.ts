import { App, TFile, TFolder } from "obsidian";
import { createVaultFolder, ensureVaultFolder, isVaultFolder } from "../vaultFolders";

describe("ensureVaultFolder", () => {
  let app: App;

  beforeEach(() => {
    app = new App();
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    (app.vault.createFolder as jest.Mock).mockResolvedValue(undefined);
    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);
    (app.vault.adapter.stat as jest.Mock).mockResolvedValue(null);
  });

  it("creates missing ancestors in order, skipping indexed folders", async () => {
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(path =>
      path === "Notes" ? new TFolder({ path }) : null);
    await ensureVaultFolder(app, "Notes/Phone/Inbox");
    expect((app.vault.createFolder as jest.Mock).mock.calls).toEqual([["Notes/Phone"], ["Notes/Phone/Inbox"]]);
    expect(app.vault.adapter.exists).not.toHaveBeenCalled();
  });

  it("accepts an unindexed ancestor confirmed by the adapter after a create race", async () => {
    (app.vault.createFolder as jest.Mock).mockRejectedValueOnce(new Error("Folder already exists."));
    (app.vault.adapter.exists as jest.Mock).mockResolvedValueOnce(true);
    (app.vault.adapter.stat as jest.Mock).mockResolvedValueOnce({ type: "folder" });
    await ensureVaultFolder(app, ".hidden/Inbox");
    expect((app.vault.createFolder as jest.Mock).mock.calls).toEqual([[".hidden"], [".hidden/Inbox"]]);
  });

  it("preserves literal URI escapes and Unicode filenames", async () => {
    await ensureVaultFolder(app, "日本語/100%20literal");
    expect((app.vault.createFolder as jest.Mock).mock.calls).toEqual([["日本語"], ["日本語/100%20literal"]]);
  });

  it("rejects indexed file blockers before creating children", async () => {
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(new TFile({ path: "Notes" }));
    await expect(ensureVaultFolder(app, "Notes/Inbox")).rejects.toThrow('Cannot create folder "Notes": a file with that name already exists');
    expect(app.vault.createFolder).not.toHaveBeenCalled();
  });

  it("rethrows an unindexed file blocker or real create failure without creating children", async () => {
    const failure = new Error("permission denied");
    (app.vault.createFolder as jest.Mock).mockRejectedValue(failure);
    (app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (app.vault.adapter.stat as jest.Mock).mockResolvedValue({ type: "file" });
    await expect(ensureVaultFolder(app, "Locked/Inbox")).rejects.toBe(failure);
    expect((app.vault.createFolder as jest.Mock).mock.calls).toEqual([["Locked"]]);
  });

  it.each(["", "/", "."])("does not create the vault root %p", async path => {
    await ensureVaultFolder(app, path);
    expect(app.vault.createFolder).not.toHaveBeenCalled();
  });
});

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
