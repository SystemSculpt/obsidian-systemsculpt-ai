import { App, TFile, TFolder } from "obsidian";
import { AgentComposerVault } from "../AgentComposerVault";

function file(path: string, mtime = 100): TFile {
  const name = path.split("/").pop()!;
  const dot = name.lastIndexOf(".");
  return Object.assign(new TFile(), {
    path,
    name,
    basename: name.slice(0, dot),
    extension: name.slice(dot + 1),
    stat: { ctime: 0, mtime, size: 4 },
  });
}

function setup(files: TFile[] = []) {
  const app = new App();
  const getFiles = jest.mocked(app.vault.getFiles).mockReturnValue(files);
  const resolve = jest.mocked(app.vault.getAbstractFileByPath).mockImplementation((path) =>
    files.find((entry) => entry.path === path) ?? null);
  const readBinary = jest.fn(async (_file: TFile) => new Uint8Array([0, 255, 13, 10]).buffer);
  Object.assign(app.vault, { readBinary });
  const openFile = jest.fn(async (_file: TFile) => undefined);
  const getLeaf = jest.fn(() => ({ openFile }));
  Object.assign(app.workspace, { getLeaf });
  return { app, vault: new AgentComposerVault(app), getFiles, resolve, readBinary, getLeaf, openFile };
}

function transfer(uriList: string, text = ""): DataTransfer {
  return {
    getData: jest.fn((format: string) => format === "text/uri-list" ? uriList : text),
  } as unknown as DataTransfer;
}

describe("AgentComposerVault", () => {
  it.each(["Notes/Plan.md", "Report.PDF", "Sketch.WEBP", "source.ts"])(
    "offers an attachable active file without reading it: %s",
    (path) => {
      const active = file(path);
      const { app, vault, readBinary } = setup([active]);
      jest.mocked(app.workspace.getActiveFile).mockReturnValue(active);

      expect(vault.activeNote()).toBe(active);
      expect(readBinary).not.toHaveBeenCalled();
    },
  );

  it("does not offer missing, unsupported or non-file active items", () => {
    const { app, vault } = setup();
    const folder = Object.assign(new TFolder(), { path: "Notes" });
    for (const active of [null, file("Recording.mp3"), folder]) {
      Object.assign(app.workspace, { getActiveFile: jest.fn(() => active) });
      expect(vault.activeNote()).toBeNull();
    }
    Reflect.deleteProperty(app.workspace, "getActiveFile");
    expect(vault.activeNote()).toBeNull();
  });

  it("resolves actual files by exact vault path, not folders or absent paths", () => {
    const note = file("Notes/Plan.md");
    const { vault, resolve } = setup([note]);
    const folder = Object.assign(new TFolder(), { path: "Notes" });
    resolve.mockImplementation((path) => path === folder.path ? folder : path === note.path ? note : null);

    expect(vault.resolve(note.path)).toBe(note);
    expect(vault.resolve(folder.path)).toBeNull();
    expect(vault.resolve("Plan.md")).toBeNull();
  });

  it("lists recent opened files once, then remaining notes by type and modification time", () => {
    const recentImage = file("Recent.png", 1);
    const recentNote = file("Old.md", 2);
    const oldNote = file("Older.md", 3);
    const newNote = file("Newer.md", 4);
    const pdf = file("Report.PDF", 7);
    const image = file("Diagram.jpg", 8);
    const text = file("Draft.txt", 9);
    const audio = file("Audio.mp3", 10);
    const { app, vault } = setup([text, audio, image, oldNote, recentNote, pdf, recentImage, newNote]);
    Object.assign(app.workspace, {
      getLastOpenFiles: jest.fn(() => ["Missing.md", audio.path, recentImage.path, recentImage.path, recentNote.path]),
    });

    expect(vault.suggest(" \t ")).toEqual([recentImage, recentNote, newNote, oldNote, pdf, image, text]);
    expect(vault.suggest("", 1)).toEqual([recentImage]);
    expect(vault.suggest("", 4)).toEqual([recentImage, recentNote, newNote, oldNote]);
  });

  it("falls back to modified files when the host has no recent-file API and keeps the default eight results", () => {
    const files = Array.from({ length: 10 }, (_, index) => file(`Note ${index}.md`, index));
    const { vault } = setup(files);

    expect(vault.suggest("")).toEqual(files.slice(2).reverse());
    expect(files.map((entry) => entry.stat.mtime)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("ranks name matches before path matches, then Markdown, PDFs, images and other text", () => {
    const markdown = file("Plan.md");
    const pdf = file("Plan.PDF");
    const image = file("Plan.PNG");
    const text = file("Plan.txt");
    const pathOnly = file("Plan/Unrelated.md");
    const unsupported = file("Plan.mp3");
    const unrelated = file("Other.md");
    const { vault } = setup([pathOnly, text, unsupported, image, unrelated, pdf, markdown]);

    expect(vault.suggest("  pLaN  ")).toEqual([markdown, pdf, image, text, pathOnly]);
    expect(vault.suggest("plan", 2)).toEqual([markdown, pdf]);
    expect(vault.suggest("zzzz")).toEqual([]);
  });

  it.each([
    { reason: "prefix", paths: ["XPlan.md", "Planning.md"], times: [1, 1], expected: ["Planning.md", "XPlan.md"] },
    { reason: "fuzzy score", paths: ["P---lan.md", "XPlan with a long title.md"], times: [1, 1], expected: ["XPlan with a long title.md", "P---lan.md"] },
    { reason: "shorter name", paths: ["Plan for today.md", "Plan.md"], times: [1, 1], expected: ["Plan.md", "Plan for today.md"] },
    { reason: "recency", paths: ["A/Plan.md", "B/Plan.md"], times: [1, 2], expected: ["B/Plan.md", "A/Plan.md"] },
    { reason: "path", paths: ["B/Plan.md", "A/Plan.md"], times: [1, 1], expected: ["A/Plan.md", "B/Plan.md"] },
  ])("breaks same-type suggestion ties by $reason", ({ paths, times, expected }) => {
    const { vault } = setup(paths.map((path, index) => file(path, times[index])));
    expect(vault.suggest("plan").map((entry) => entry.path)).toEqual(expected);
  });

  it("queries the current vault file list rather than keeping stale mention suggestions", () => {
    const oldNote = file("Old plan.md");
    const newNote = file("New plan.md");
    const { vault, getFiles } = setup([oldNote]);
    expect(vault.suggest("plan")).toEqual([oldNote]);

    getFiles.mockReturnValue([newNote]);
    expect(vault.suggest("plan")).toEqual([newNote]);
  });

  it("reads exact attachment bytes and preserves the name and modification time", async () => {
    const image = file("Images/Diagram.png", 123456);
    const { vault, readBinary } = setup([image]);

    const attachment = await vault.read(image);

    expect(readBinary).toHaveBeenCalledTimes(1);
    expect(readBinary).toHaveBeenCalledWith(image);
    expect(attachment).toBeInstanceOf(File);
    expect(attachment.name).toBe("Diagram.png");
    expect(attachment.lastModified).toBe(123456);
    expect(new Uint8Array(await attachment.arrayBuffer())).toEqual(new Uint8Array([0, 255, 13, 10]));
  });

  it("propagates a read failure instead of producing an empty attachment", async () => {
    const note = file("Plan.md");
    const { vault, readBinary } = setup([note]);
    const error = new Error("File disappeared during read");
    readBinary.mockRejectedValueOnce(error);
    await expect(vault.read(note)).rejects.toBe(error);
  });

  it("delegates unambiguous wiki links to Obsidian with the current source path", () => {
    const note = file("Projects/Plan.md");
    const { app, vault: defaultVault } = setup([note]);
    const fileToLinktext = jest.fn(() => "Projects/Plan");
    Object.assign(app.metadataCache, { fileToLinktext });
    let source = "Chats/First.md";
    const vault = new AgentComposerVault(app, () => source);

    expect(vault.linkText(note)).toBe("Projects/Plan");
    expect(fileToLinktext).toHaveBeenLastCalledWith(note, "Chats/First.md", true);
    source = "Chats/Second.md";
    vault.linkText(note);
    expect(fileToLinktext).toHaveBeenLastCalledWith(note, "Chats/Second.md", true);
    defaultVault.linkText(note);
    expect(fileToLinktext).toHaveBeenLastCalledWith(note, "", true);
  });

  it("uses readable Markdown and attachment names when the host has no link-text API", () => {
    const { vault } = setup();
    expect(vault.linkText(file("Notes/Plan.md"))).toBe("Plan");
    expect(vault.linkText(file("Assets/Plan.pdf"))).toBe("Plan.pdf");
  });

  it("opens the selected file in the existing leaf and propagates host errors", async () => {
    const note = file("Notes/Plan.md");
    const { vault, getLeaf, openFile } = setup([note]);
    await vault.open(note);
    expect(getLeaf).toHaveBeenCalledWith(false);
    expect(openFile).toHaveBeenCalledWith(note);

    const error = new Error("Unable to open note");
    openFile.mockRejectedValueOnce(error);
    await expect(vault.open(note)).rejects.toBe(error);
  });

  it("accepts native single and multi-file drags, removing duplicates and unsupported entries", () => {
    const note = file("Plan.md");
    const image = file("Diagram.png");
    const { app, vault } = setup([note, image]);
    Object.assign(app, {
      dragManager: { draggable: {
        file: note,
        files: [note, image, image, file("Sound.wav"), new TFolder(), { path: "Fake.md" }, null],
      } },
    });
    const urls = transfer("obsidian://open?file=Other.md");

    expect(vault.isDraggingVaultFiles()).toBe(true);
    expect(vault.draggedFiles(urls)).toEqual([note, image]);
    expect(urls.getData).not.toHaveBeenCalled();
  });

  it("does not advertise empty, unsupported or malformed native drags as vault files", () => {
    const { app, vault } = setup();
    expect(vault.draggedFiles()).toEqual([]);
    expect(vault.isDraggingVaultFiles()).toBe(false);
    for (const draggable of [null, {}, { file: file("Sound.wav") }, { file: "Plan.md", files: "Plan.md" }]) {
      Object.assign(app, { dragManager: { draggable } });
      expect(vault.draggedFiles(null)).toEqual([]);
      expect(vault.isDraggingVaultFiles()).toBe(false);
    }
  });

  it("resolves cross-window Obsidian URLs from both transfer formats, once per file", () => {
    const note = file("Notes/Plan #1 ü.md");
    const image = file("Images/Diagram.png");
    const { vault } = setup([note, image]);
    const noteUrl = `obsidian://open?file=${encodeURIComponent(note.path.slice(0, -3))}`;
    const imageUrl = `obsidian://open?file=${encodeURIComponent(image.path)}`;
    const urls = transfer(`  ${noteUrl} \r\n${imageUrl}`, `${noteUrl}\n${imageUrl}`);

    expect(vault.draggedFiles(urls)).toEqual([note, image]);
    expect(urls.getData).toHaveBeenCalledWith("text/uri-list");
    expect(urls.getData).toHaveBeenCalledWith("text/plain");
  });

  it("ignores non-Obsidian links, absent paths, missing files, folders and unsupported URL attachments", () => {
    const note = file("Plan.md");
    const audio = file("Sound.wav");
    const { vault, resolve } = setup([note, audio]);
    resolve.mockImplementation((path) => path === "Notes" ? new TFolder() : path === audio.path ? audio : null);
    const urls = transfer([
      "# Comment",
      "https://example.com/Plan.md",
      "file:///Plan.md",
      "Plan.md",
      "obsidian://open?vault=Test",
      "obsidian://open?file=",
      "obsidian://open?file=Missing",
      "obsidian://open?file=Notes",
      "obsidian://open?file=Sound.wav",
    ].join("\n"));

    expect(vault.draggedFiles(urls)).toEqual([]);
  });

  it("falls back to URL drag data when the native manager has no file objects", () => {
    const note = file("Plan.md");
    const { app, vault } = setup([note]);
    Object.assign(app, { dragManager: { draggable: { file: "Plan.md", files: [null, "Plan.md"] } } });

    expect(vault.draggedFiles(transfer("", "obsidian://open?file=Plan.md"))).toEqual([note]);
  });
});
