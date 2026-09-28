import { App, TFile, TFolder } from "obsidian";
import { applyVaultCleanup, scanVaultCleanup } from "../VaultCleanup";

const settings = {
  chatsDirectory: "SystemSculpt/Chats",
  extractionsDirectory: "SystemSculpt/Extractions",
  recordingsDirectory: "SystemSculpt/Recordings",
};

function harness() {
  const app = new App();
  const files: TFile[] = [];
  const folders: TFolder[] = [];
  const contents = new Map<TFile, string>();
  (app.vault.getFiles as jest.Mock).mockImplementation(() => files);
  (app.vault.getAllLoadedFiles as jest.Mock).mockImplementation(() => [...files, ...folders]);
  (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path) => [...files, ...folders].find((file) => file.path === path) ?? null);
  (app.vault.read as jest.Mock).mockImplementation(async (file) => contents.get(file) ?? "content");
  const trash = jest.fn(async (file: TFile | TFolder) => {
    const list = file instanceof TFile ? files : folders;
    list.splice(list.indexOf(file as never), 1);
    for (const folder of folders) folder.children = folder.children.filter((child) => child !== file);
  });
  (app.fileManager as any).trashFile = trash;
  const addFile = (path: string, content = "content") => {
    const file = new TFile({ path, extension: path.split(".").pop(), stat: { size: content.length, mtime: 1 } });
    files.push(file);
    contents.set(file, content);
    return file;
  };
  return { app, files, folders, contents, trash, addFile };
}

describe("reviewed vault cleanup", () => {
  it("matches directory segments and retains transcripts alongside recordings", async () => {
    const h = harness();
    const chat = h.addFile(`${settings.chatsDirectory}/saved.md`);
    h.addFile(`${settings.chatsDirectory}-archive/keep.md`);
    const audio = h.addFile(`${settings.recordingsDirectory}/take.wav`);
    h.addFile(`${settings.recordingsDirectory}/take.md`);
    h.addFile(`${settings.recordingsDirectory}/take.srt`);

    const plan = await scanVaultCleanup(h.app, settings);
    expect(plan.chat.items.map((item) => item.file)).toEqual([chat]);
    expect(plan.recording.items.map((item) => item.file)).toEqual([audio]);
  });

  it.each(["", "/", ".", "..", "SystemSculpt/../Chats", "/SystemSculpt/Chats"])("rejects unsafe configured directory %j", async (directory) => {
    const h = harness();
    h.addFile("SystemSculpt/Chats/saved.md");
    expect((await scanVaultCleanup(h.app, { ...settings, chatsDirectory: directory })).chat.items).toEqual([]);
  });

  it("does not treat authored frontmatter as empty", async () => {
    const h = harness();
    const empty = h.addFile("empty.md", " \n\t");
    h.addFile("metadata.md", "---\nimportant: saved\n---\n");
    expect((await scanVaultCleanup(h.app, settings)).empty.items.map((item) => item.file)).toEqual([empty]);
  });

  it("applies only the unchanged identities from the confirmed snapshot", async () => {
    const h = harness();
    const selected = h.addFile(`${settings.chatsDirectory}/selected.md`);
    const edited = h.addFile(`${settings.chatsDirectory}/edited.md`);
    const moved = h.addFile(`${settings.chatsDirectory}/moved.md`);
    const replaced = h.addFile(`${settings.chatsDirectory}/replaced.md`);
    const plan = await scanVaultCleanup(h.app, settings);
    h.addFile(`${settings.chatsDirectory}/new-arrival.md`);
    edited.stat.mtime++;
    moved.path = `${settings.chatsDirectory}/renamed.md`;
    h.files.splice(h.files.indexOf(replaced), 1);
    h.addFile(replaced.path);

    expect(await applyVaultCleanup(h.app, plan.chat)).toEqual({ trashed: 1, skipped: 3 });
    expect(h.trash.mock.calls.map(([file]) => file)).toEqual([selected]);
  });

  it("rechecks emptiness even when metadata has not changed", async () => {
    const h = harness();
    const file = h.addFile("empty.md", "  ");
    const plan = await scanVaultCleanup(h.app, settings);
    h.contents.set(file, "hi");
    expect(await applyVaultCleanup(h.app, plan.empty)).toEqual({ trashed: 0, skipped: 1 });
    expect(h.trash).not.toHaveBeenCalled();
  });

  it("preserves folders that acquired contents and excludes the vault root", async () => {
    const h = harness();
    const folder = new TFolder({ path: "empty", children: [] });
    h.folders.push(folder, new TFolder({ path: "", children: [] }));
    const plan = await scanVaultCleanup(h.app, settings);
    expect(plan.empty.items.map((item) => item.path)).toEqual(["empty"]);
    folder.children.push(h.addFile("empty/new.md"));
    expect(await applyVaultCleanup(h.app, plan.empty)).toEqual({ trashed: 0, skipped: 1 });
  });

  it("removes only reviewed folders that are empty after their files were trashed", async () => {
    const h = harness();
    const file = h.addFile(`${settings.chatsDirectory}/nested/saved.md`);
    const nested = new TFolder({ path: `${settings.chatsDirectory}/nested`, children: [file] });
    const root = new TFolder({ path: settings.chatsDirectory, children: [nested] });
    h.folders.push(root, nested);
    const plan = await scanVaultCleanup(h.app, settings);
    await applyVaultCleanup(h.app, plan.chat);
    expect(h.trash.mock.calls.map(([entry]) => entry)).toEqual([file, nested, root]);
  });
});
