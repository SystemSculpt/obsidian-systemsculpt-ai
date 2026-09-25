/**
 * @jest-environment jsdom
 */
import { App, TFile, TFolder } from "obsidian";
import { FileOperations } from "../tools/FileOperations";
import { DirectoryOperations } from "../tools/DirectoryOperations";
import { normalizeLocalToolOutcome } from "../../../services/SystemSculptService";
import { safeOutboundVaultToolResult } from "../../../chat/managed/WireConversation";

jest.mock("../../../services/search/VaultExclusions", () => ({
  searchVaultExclusions: () => ({ isExcluded: () => false, isFolderExcluded: () => false }),
}));

function vaultWith(paths: { files?: string[]; folders?: string[] }): App {
  const app = new App();
  const entries = new Map<string, TFile | TFolder>();
  for (const path of paths.folders ?? []) entries.set(path, new TFolder({ path }));
  for (const path of paths.files ?? []) entries.set(path, new TFile({ path }));
  (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => entries.get(path) ?? null);
  (app.vault.create as jest.Mock).mockImplementation(async (path: string) => {
    const file = new TFile({ path });
    entries.set(path, file);
    return file;
  });
  (app.vault.createFolder as jest.Mock).mockImplementation(async (path: string) => {
    entries.set(path, new TFolder({ path }));
  });
  (app.fileManager.renameFile as jest.Mock).mockResolvedValue(undefined);
  return app;
}

/** What the model receives after the managed tool-result boundary. */
function outbound(tool: string, data: unknown): any {
  return safeOutboundVaultToolResult(normalizeLocalToolOutcome(data, tool));
}

describe("agent file tools create names that work on every device", () => {
  it("writes a new file under a portable name and tells the agent which path it used", async () => {
    const app = vaultWith({ folders: ["Notes"] });
    const result = await new FileOperations(app, ["/"]).writeFile({
      path: "Notes/Standup (23:11).md",
      content: "hello",
    });

    expect(app.vault.create).toHaveBeenCalledWith("Notes/Standup (23 11).md", "hello");
    expect(result).toMatchObject({
      path: "Notes/Standup (23 11).md",
      requestedPath: "Notes/Standup (23:11).md",
      success: true,
    });
    const delivered = outbound("write", result);
    expect(delivered.success).toBe(true);
    expect(delivered.data.path).toBe("Notes/Standup (23 11).md");
    expect(delivered.data.notice).toContain('Use "Notes/Standup (23 11).md" in later steps.');
  });

  it("creates missing parent folders under portable names too", async () => {
    const app = vaultWith({});
    const result = await new FileOperations(app, ["/"]).writeFile({
      path: "Plans: Q1/Launch #1/.draft.md",
      content: "x",
    });

    expect(result.path).toBe("Plans Q1/Launch 1/draft.md");
    expect(app.vault.createFolder).toHaveBeenCalledWith("Plans Q1");
    expect(app.vault.createFolder).toHaveBeenCalledWith("Plans Q1/Launch 1");
    expect(app.vault.create).toHaveBeenCalledWith("Plans Q1/Launch 1/draft.md", "x");
  });

  it("keeps existing folders and files at their exact names so they can still be edited or repaired", async () => {
    const app = vaultWith({ folders: ["Old: Folder"], files: ["Old: Folder/Note?.md"] });
    (app.vault.read as jest.Mock).mockResolvedValue("before");
    const ops = new FileOperations(app, ["/"]);

    const overwrite = await ops.writeFile({ path: "Old: Folder/Note?.md", content: "after" });
    expect(overwrite).toEqual({ path: "Old: Folder/Note?.md", success: true });
    expect(app.vault.modify).toHaveBeenCalledWith(expect.objectContaining({ path: "Old: Folder/Note?.md" }), "after");

    const sibling = await ops.writeFile({ path: "Old: Folder/New: note.md", content: "new" });
    expect(sibling.path).toBe("Old: Folder/New note.md");
    expect(app.vault.create).toHaveBeenCalledWith("Old: Folder/New note.md", "new");
  });

  it("honors ifExists against the portable path a previous write created", async () => {
    const app = vaultWith({ files: ["a b.md"] });
    await expect(new FileOperations(app, ["/"]).writeFile({ path: "a:b.md", content: "x", ifExists: "error" }))
      .rejects.toThrow("File already exists: a b.md");
    expect(app.vault.create).not.toHaveBeenCalled();
  });

  it("does not rename a hidden SystemSculpt path", async () => {
    const app = vaultWith({});
    const adapter = app.vault.adapter as unknown as Record<string, jest.Mock>;
    adapter.exists.mockResolvedValue(false);
    const result = await new FileOperations(app, ["/"]).writeFile({ path: ".systemsculpt/scratch.md", content: "x" });
    expect(result).toEqual({ path: ".systemsculpt/scratch.md", success: true });
  });

  it("refuses a portable path that would leave the allowed folder", async () => {
    const app = vaultWith({});
    await expect(new FileOperations(app, ["Proj: A"]).writeFile({ path: "Proj: A/x.md", content: "x" }))
      .rejects.toThrow("Access denied: Proj A/x.md");
    expect(app.vault.create).not.toHaveBeenCalled();
  });

  it("creates folders under portable names and reports each change", async () => {
    const app = vaultWith({ folders: ["Archive"] });
    const plugin = { settings: {} } as any;
    const { results } = await new DirectoryOperations(app, ["/"], plugin).createDirectories({
      paths: ["Archive/2026: Q3", "Archive/Clean"],
    });

    expect(app.vault.createFolder).toHaveBeenCalledWith("Archive/2026 Q3");
    expect(results[0]).toMatchObject({ path: "Archive/2026 Q3", requestedPath: "Archive/2026: Q3", success: true });
    expect(results[0].notice).toContain("Archive/2026 Q3");
    expect(results[1]).toEqual({ path: "Archive/Clean", success: true });
  });

  it("moves to a portable destination, allows an unsafe source, and reports the destination it used", async () => {
    const app = vaultWith({ folders: ["Done"], files: ["Inbox/Title (23:11).md"] });
    const plugin = { settings: {} } as any;
    const { results } = await new DirectoryOperations(app, ["/"], plugin).moveItems({
      items: [{ source: "Inbox/Title (23:11).md", destination: "Done/Title (23:11).md" }],
    });

    expect(app.fileManager.renameFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "Inbox/Title (23:11).md" }),
      "Done/Title (23 11).md",
    );
    expect(results[0]).toMatchObject({
      source: "Inbox/Title (23:11).md",
      destination: "Done/Title (23 11).md",
      requestedDestination: "Done/Title (23:11).md",
      success: true,
    });
    const delivered = outbound("move", { results });
    expect(delivered.data.results[0].destination).toBe("Done/Title (23 11).md");
    expect(delivered.data.results[0].notice).toContain("Obsidian Sync");
  });
});
