import type { App } from "obsidian";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedJobRecoveryStore } from "../ManagedJobRecoveryStore";
import { ObsidianManagedRecoveryAdapter } from "../adapters/ObsidianManagedRecoveryAdapter";

function createAdapter(name = "Research vault") {
  const host = {
    read: jest.fn(async (_path: string): Promise<string> => "saved bytes"),
    write: jest.fn(async (_path: string, _contents: string): Promise<void> => undefined),
    exists: jest.fn(async (_path: string): Promise<boolean> => true),
    rename: jest.fn(async (_from: string, _to: string): Promise<void> => undefined),
    remove: jest.fn(async (_path: string): Promise<void> => undefined),
    mkdir: jest.fn(async (_path: string): Promise<void> => undefined),
    list: jest.fn(async (_path: string): Promise<{ files: string[]; folders: string[] }> => ({ files: [], folders: [] })),
  };
  const app = { vault: { adapter: host, getName: () => name } } as unknown as App;
  return { host, app, adapter: new ObsidianManagedRecoveryAdapter(app) };
}

const root = ".systemsculpt/managed-jobs";
const directory = `${root}/transcription`;
const path = `${directory}/op-1.json`;

describe("ObsidianManagedRecoveryAdapter", () => {
  it.each([
    ["Team._:notes-2", "obsidian:Team._:notes-2"],
    ["  Research & notes!  ", "obsidian:Research-notes"],
    ["笔记", "obsidian:vault"],
    ["", "obsidian:vault"],
    ["a".repeat(300), `obsidian:${"a".repeat(220)}`],
  ])("provides a stable recovery domain for vault name %j", (name, expected) => {
    const { adapter } = createAdapter(name);
    expect(adapter.storageDomain).toBe(expected);
    expect(createAdapter(name).adapter.storageDomain).toBe(expected);
    expect(new ManagedJobRecoveryStore(adapter).storageDomain).toBe(expected);
    expect(adapter.capabilities).toEqual({
      read: true, write: true, list: true, mkdir: true, atomicRename: true, remove: true,
    });
    expect(Object.isFrozen(adapter.capabilities)).toBe(true);
  });

  it("forwards exact recovery bytes and vault-relative paths with the host receiver intact", async () => {
    const { adapter, host } = createAdapter();
    const contents = '{"source":"笔记/audio clip.wav","revision":2}\n';
    host.read.mockResolvedValue(contents);
    host.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(adapter.read(path)).resolves.toBe(contents);
    await expect(adapter.write(`${path}.tmp`, contents)).resolves.toBeUndefined();
    await expect(adapter.exists(path)).resolves.toBe(false);
    await expect(adapter.exists(path)).resolves.toBe(true);
    await expect(adapter.rename(`${path}.tmp`, path)).resolves.toBeUndefined();
    await expect(adapter.remove(`${path}.journal`)).resolves.toBeUndefined();

    expect(host.read).toHaveBeenCalledWith(path);
    expect(host.write).toHaveBeenCalledWith(`${path}.tmp`, contents);
    expect(host.exists.mock.calls).toEqual([[path], [path]]);
    expect(host.rename).toHaveBeenCalledWith(`${path}.tmp`, path);
    expect(host.remove).toHaveBeenCalledWith(`${path}.journal`);
    for (const method of [host.read, host.write, host.exists, host.rename, host.remove]) {
      expect(method.mock.contexts.every(context => context === host)).toBe(true);
    }
  });

  it.each(["read", "write", "exists", "rename", "remove"] as const)(
    "preserves a host %s failure instead of reporting recovery success",
    async method => {
      const { adapter, host } = createAdapter();
      const failure = new Error(`${method} failed`);
      host[method].mockRejectedValueOnce(failure);
      const operations = {
        read: () => adapter.read(path),
        write: () => adapter.write(path, "bytes"),
        exists: () => adapter.exists(path),
        rename: () => adapter.rename(path, `${path}.bak`),
        remove: () => adapter.remove(path),
      };
      await expect(operations[method]()).rejects.toBe(failure);
      expect(host[method]).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [[], [".systemsculpt", root, directory]],
    [[".systemsculpt"], [root, directory]],
    [[".systemsculpt", root, directory], []],
  ])("creates only missing parents, in order, with existing folders %j", async (existing, expected) => {
    const { adapter, host } = createAdapter();
    const folders = new Set(["", ...existing]);
    host.exists.mockImplementation(async folder => folders.has(folder));
    host.mkdir.mockImplementation(async folder => {
      expect(folders.has(folder.slice(0, Math.max(0, folder.lastIndexOf("/"))))).toBe(true);
      folders.add(folder);
    });

    await adapter.mkdir(`/${root}//transcription/`);

    expect(host.mkdir.mock.calls).toEqual(expected.map(folder => [folder]));
    expect(folders.has(directory)).toBe(true);
    await adapter.mkdir(directory);
    expect(host.mkdir.mock.calls).toEqual(expected.map(folder => [folder]));
  });

  it.each(["", "/", "///"])("does not create or probe a folder for empty path %j", async value => {
    const { adapter, host } = createAdapter();
    await expect(adapter.mkdir(value)).resolves.toBeUndefined();
    expect(host.exists).not.toHaveBeenCalled();
    expect(host.mkdir).not.toHaveBeenCalled();
  });

  it.each(["exists", "mkdir"] as const)("stops at a parent %s failure", async method => {
    const { adapter, host } = createAdapter();
    const failure = new Error("Storage unavailable");
    host.exists.mockResolvedValue(false);
    host[method].mockRejectedValueOnce(failure);

    await expect(adapter.mkdir(directory)).rejects.toBe(failure);

    expect(host.exists.mock.calls).toEqual([[".systemsculpt"]]);
    expect(host.mkdir.mock.calls).toEqual(method === "mkdir" ? [[".systemsculpt"]] : []);
  });

  it("returns no recovery files when the directory does not exist", async () => {
    const { adapter, host } = createAdapter();
    host.exists.mockResolvedValue(false);
    await expect(adapter.list(root)).resolves.toEqual([]);
    expect(host.exists).toHaveBeenCalledWith(root);
    expect(host.list).not.toHaveBeenCalled();
    expect(host.mkdir).not.toHaveBeenCalled();
  });

  it("lists every nested file, including crash-recovery artifacts, but not folders", async () => {
    const { adapter, host } = createAdapter();
    const imageDirectory = `${root}/image_generation`;
    const nested = `${directory}/nested`;
    const tree: Record<string, { files: string[]; folders: string[] }> = {
      [root]: { files: [`${root}/note.txt`], folders: [directory, imageDirectory] },
      [directory]: { files: [path, `${path}.journal`], folders: [nested] },
      [nested]: { files: [`${nested}/op-2.json.tmp`, `${nested}/op-2.json.bak`], folders: [] },
      [imageDirectory]: { files: [], folders: [] },
    };
    host.list.mockImplementation(async folder => tree[folder]);
    const expected = [
      `${root}/note.txt`, path, `${path}.journal`, `${nested}/op-2.json.tmp`, `${nested}/op-2.json.bak`,
    ];

    await expect(adapter.list(root)).resolves.toEqual(expected);
    expect(host.list.mock.calls).toEqual([[root], [directory], [nested], [imageDirectory]]);
    await expect(adapter.list(root)).resolves.toEqual(expected);
    await expect(adapter.list(imageDirectory)).resolves.toEqual([]);
    expect(host.remove).not.toHaveBeenCalled();
  });

  it("propagates a failed existence check rather than treating recovery files as absent", async () => {
    const { adapter, host } = createAdapter();
    const failure = new Error("Vault unavailable");
    host.exists.mockRejectedValueOnce(failure);
    await expect(adapter.list(root)).rejects.toBe(failure);
    expect(host.list).not.toHaveBeenCalled();
  });

  it.each([root, directory])("rejects the whole scan when listing %s fails", async failedPath => {
    const { adapter, host } = createAdapter();
    const failure = new Error("Cannot list recovery files");
    host.list.mockImplementation(async folder => {
      if (folder === failedPath) throw failure;
      return { files: [`${root}/found.json`], folders: [directory] };
    });
    await expect(adapter.list(root)).rejects.toBe(failure);
    expect(host.remove).not.toHaveBeenCalled();
  });

  it("recovers an interrupted write after reopening and deletes only the retired job on disk", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ss-recovery-adapter-"));
    const { adapter, host, app } = createAdapter("Recovery fixture");
    host.read.mockImplementation(file => readFile(join(vault, file), "utf8"));
    host.write.mockImplementation((file, contents) => writeFile(join(vault, file), contents));
    host.exists.mockImplementation(async file => {
      try { await stat(join(vault, file)); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    });
    host.mkdir.mockImplementation(async folder => { await mkdir(join(vault, folder)); });
    host.rename.mockImplementation((from, to) => rename(join(vault, from), join(vault, to)));
    host.remove.mockImplementation(file => unlink(join(vault, file)));
    host.list.mockImplementation(async folder => {
      const entries = await readdir(join(vault, folder), { withFileTypes: true });
      return {
        files: entries.filter(entry => entry.isFile()).map(entry => `${folder}/${entry.name}`),
        folders: entries.filter(entry => entry.isDirectory()).map(entry => `${folder}/${entry.name}`),
      };
    });
    const source = { identity: "vault:audio.wav", fingerprint: `sha256:${"a".repeat(64)}` };

    try {
      await writeFile(join(vault, "keep.md"), "User note");
      const store = new ManagedJobRecoveryStore(adapter);
      await store.initialize();
      const admitted = await store.createAdmitted({ capability: "transcription", operationId: "op-1", source });
      host.rename.mockRejectedValueOnce(new Error("Interrupted rename"));
      await expect(store.markContentReady("transcription", "op-1", admitted.revision))
        .rejects.toMatchObject({ code: "recovery_unavailable" });
      expect(await adapter.list(root)).toEqual(expect.arrayContaining([path, `${path}.tmp`, `${path}.journal`]));

      const reopened = new ManagedJobRecoveryStore(new ObsidianManagedRecoveryAdapter(app));
      await reopened.initialize();
      const recovered = await reopened.read("transcription", "op-1");
      expect(recovered).toMatchObject({ phase: "content_ready", revision: 2, source });
      await expect(reopened.findExactSourceMatches("transcription", source)).resolves.toEqual([recovered]);
      await expect(adapter.list(root)).resolves.toEqual([path]);

      const abandoned = await reopened.abandon("transcription", "op-1", recovered.revision);
      await reopened.delete("transcription", "op-1", abandoned.revision);
      await expect(reopened.readOptional("transcription", "op-1")).resolves.toBeNull();
      await expect(adapter.list(root)).resolves.toEqual([]);
      await expect(readFile(join(vault, "keep.md"), "utf8")).resolves.toBe("User note");
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});
