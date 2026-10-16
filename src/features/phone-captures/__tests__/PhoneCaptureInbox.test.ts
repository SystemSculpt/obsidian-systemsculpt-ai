import { TFile, TFolder, type App } from "obsidian";
import YAML from "yaml";
import {
  PHONE_CAPTURE_LINK_CHECK_GAP_MS,
  PHONE_CAPTURE_MIN_SYNC_GAP_MS,
  PhoneCaptureInbox,
  type PhoneCaptureSettings,
} from "../PhoneCaptureInbox";
import type { PlatformRequestClient, PlatformRequestInput } from "../../../services/PlatformRequestClient";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  const YAML = jest.requireActual("yaml");
  return { ...actual, stringifyYaml: (value: unknown) => YAML.stringify(value), parseYaml: (value: string) => YAML.parse(value) };
});

function fakeVault(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const folders = new Set<string>();
  const objects = new Map<string, TFile>();
  const unindexed = new Set<string>();
  const listeners = new Map<object, { event: string; callback: (file: TFile) => void }>();
  const fileAt = (path: string) => {
    if (!files.has(path)) return null;
    if (!objects.has(path)) objects.set(path, new TFile({ path }));
    const file = objects.get(path)!;
    file.stat = { size: Buffer.byteLength(files.get(path)!), mtime: 1, ctime: 1 };
    return file;
  };
  const emit = (event: string, file: TFile) => {
    for (const listener of listeners.values()) if (listener.event === event) listener.callback(file);
  };
  const vault = {
    on: jest.fn((event: string, callback: (file: TFile) => void) => {
      const ref = {}; listeners.set(ref, { event, callback }); return ref;
    }),
    offref: jest.fn((ref: object) => { listeners.delete(ref); }),
    getAbstractFileByPath: (path: string) => fileAt(path) ?? (folders.has(path) ? new TFolder({ path }) : null),
    createFolder: jest.fn(async (path: string) => { folders.add(path); }),
    create: jest.fn(async (path: string, content: string) => {
      if (files.has(path)) throw new Error("File already exists.");
      files.set(path, content);
      const file = fileAt(path)!;
      emit("create", file);
      return file;
    }),
    read: jest.fn(async (file: TFile) => {
      if (!files.has(file.path)) throw new Error("File missing");
      return files.get(file.path)!;
    }),
    getMarkdownFiles: jest.fn(() => [...files.keys()].filter((p) => p.endsWith(".md")).map((path) => fileAt(path)!)),
  };
  const metadataCache = {
    getFileCache: jest.fn((file: TFile) => {
      if (unindexed.has(file.path)) return null;
      const match = /^---\n([\s\S]*?)---\n/.exec(files.get(file.path) ?? "");
      return match ? { frontmatter: YAML.parse(match[1]), sections: [{ type: "yaml" }] } : { sections: [{ type: "paragraph" }] };
    }),
  };
  return { app: { vault, metadataCache } as unknown as App, files, vault, unindexed, listeners, emit, metadataCache };
}

type Route = (input: PlatformRequestInput) => { status: number; body: unknown };

function fakeServer(captures: Record<string, unknown>[]) {
  const pending = new Map(captures.map((c) => [c.id as string, c]));
  const acks: Array<{ id: string; body: unknown; headers: Record<string, string> }> = [];
  const requests: PlatformRequestInput[] = [];
  let override: ((input: PlatformRequestInput) => { status: number; body: unknown } | null) | null = null;
  const client = {
    request: jest.fn(async (input: PlatformRequestInput) => {
      requests.push(input);
      const reply = override?.(input) ?? route(input);
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }),
  } as unknown as PlatformRequestClient;
  const route: Route = (input) => {
    const url = new URL(input.url);
    const ack = /\/captures\/([^/]+)\/ack$/.exec(url.pathname);
    if (ack && input.method === "POST") {
      acks.push({ id: ack[1], body: input.body, headers: input.headers ?? {} });
      pending.delete(ack[1]);
      return { status: 200, body: { capture: { id: ack[1], status: "delivered" } } };
    }
    return { status: 200, body: { captures: [...pending.values()], next_cursor: null } };
  };
  return {
    client,
    acks,
    requests,
    pending,
    setOverride: (next: typeof override) => { override = next; },
  };
}

const CAPTURE = {
  id: "cap_1",
  kind: "text",
  status: "ready",
  created_at: "2026-10-14T12:00:00.000Z",
  title: "Friday oat milk",
  markdown: "- [ ] Buy oat milk\n",
  tags: ["#groceries", "errands"],
  source: "ios",
};

function setup(options: Readonly<{
  captures?: Record<string, unknown>[];
  files?: Record<string, string>;
  settings?: Partial<PhoneCaptureSettings>;
  confirm?: jest.Mock;
  checkLinked?: () => Promise<boolean>;
}> = {}) {
  const host = fakeVault(options.files);
  const { app, files, vault } = host;
  const server = fakeServer(options.captures ?? [CAPTURE]);
  let now = 1_000_000;
  let settings: PhoneCaptureSettings = {
    licenseKey: "lic_test",
    enabled: true,
    folder: "",
    askBeforeSaving: false,
    linked: true,
    ...options.settings,
  };
  const notify = jest.fn();
  const confirm = options.confirm ?? jest.fn(async () => true);
  const checkLinked = jest.fn(options.checkLinked ?? (async () => true));
  const onLinked = jest.fn(async () => { settings = { ...settings, linked: true }; });
  const makeInbox = () => new PhoneCaptureInbox({
    app,
    settings: () => settings,
    pluginVersion: "6.12.0",
    confirm,
    notify,
    checkLinked,
    onLinked,
    requestClient: server.client,
    baseUrl: "https://api.example.test/api/plugin",
    now: () => now,
  });
  return {
    ...host, inbox: makeInbox(), makeInbox, files, vault, server, notify, confirm, checkLinked, onLinked,
    advance: (ms: number) => { now += ms; },
  };
}

describe("PhoneCaptureInbox", () => {
  it("writes a ready capture as a new note and acknowledges its vault path", async () => {
    const { inbox, files, server, notify } = setup();

    const result = await inbox.sync();

    const path = "SystemSculpt/Inbox/Friday oat milk 2026-10-14.md";
    expect(result.saved).toEqual([path]);
    const note = files.get(path) ?? "";
    expect(YAML.parse(/^---\n([\s\S]*?)---\n/.exec(note)![1])).toEqual({
      source: "ios",
      captured: "2026-10-14T12:00:00.000Z",
      tags: ["groceries", "errands"],
      capture_id: "cap_1",
    });
    expect(note.endsWith("\n\n- [ ] Buy oat milk\n")).toBe(true);

    const list = new URL(server.requests[0].url);
    expect(list.pathname).toBe("/api/plugin/captures");
    expect(list.searchParams.get("status")).toBe("ready");
    expect(server.requests[0].headers).toMatchObject({ "x-license-key": "lic_test", "x-plugin-version": "6.12.0" });
    expect(server.acks).toEqual([expect.objectContaining({ id: "cap_1", body: { vault_path: path } })]);
    expect(server.acks[0].headers["Idempotency-Key"]).toMatch(/^ack-cap_1-[0-9a-f]{16}$/);
    expect(notify).toHaveBeenCalledWith("Saved 1 iOS capture to SystemSculpt/Inbox.");
  });

  it("never overwrites an existing note with the same name", async () => {
    const existing = "SystemSculpt/Inbox/Friday oat milk 2026-10-14.md";
    const { inbox, files } = setup({ files: { [existing]: "mine" }, settings: { folder: "SystemSculpt/Inbox" } });

    const result = await inbox.sync();

    expect(files.get(existing)).toBe("mine");
    expect(result.saved).toEqual(["SystemSculpt/Inbox/Friday oat milk 2026-10-14 2.md"]);
  });

  it("saves a capture whose name differs from an existing note only in letter case", async () => {
    const existing = "SystemSculpt/Inbox/Friday Oat Milk 2026-10-14.md";
    const { inbox, files, vault, server } = setup({ files: { [existing]: "mine" } });
    // A case-insensitive disk (macOS, Windows, iOS) refuses the differently cased name.
    const create = vault.create.getMockImplementation()!;
    vault.create.mockImplementation(async (path: string, content: string) => {
      if ([...files.keys()].some((p) => p.toLowerCase() === path.toLowerCase())) throw new Error("File already exists.");
      return create(path, content);
    });

    const result = await inbox.sync();

    const path = "SystemSculpt/Inbox/Friday oat milk 2026-10-14 2.md";
    expect(files.get(existing)).toBe("mine");
    expect(result).toMatchObject({ saved: [path], failed: 0 });
    expect(server.acks).toEqual([expect.objectContaining({ id: "cap_1", body: { vault_path: path } })]);
  });

  it("acknowledges a re-delivered capture that is already in the vault without writing again", async () => {
    const moved = "Notes/Moved capture.md";
    const { inbox, vault, server } = setup({
      files: { [moved]: "---\ncapture_id: cap_1\nsource: ios\n---\n\nBody\n" },
    });

    const result = await inbox.sync();

    expect(vault.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ saved: [], alreadyInVault: 1 });
    expect(server.acks).toEqual([expect.objectContaining({ id: "cap_1", body: { vault_path: moved } })]);
  });

  it("finds an immediate external write before metadata indexing, even at a moved path", async () => {
    const h = setup();
    const path = "Elsewhere/URI note.md";
    await h.vault.create(path, "---\ncapture_id: cap_1\n---\n\nCafé 日本語 & = #\n");
    h.unindexed.add(path);
    h.vault.create.mockClear();

    expect(await h.makeInbox().sync()).toMatchObject({ saved: [], alreadyInVault: 1, failed: 0 });
    expect(h.vault.create).not.toHaveBeenCalled();
    expect(h.files.size).toBe(1);
    expect(h.server.acks[0].body).toEqual({ vault_path: path });
  });

  it("reconciles an empty cached snapshot of a nonempty URI-created note", async () => {
    const path = "From URI.md";
    const h = setup({ files: { [path]: "---\ncapture_id: cap_1\n---\nBody" } });
    // Obsidian's URI handler creates an empty file, then modifies its content.
    // getFileCache can still return the indexed empty-file snapshot at sync.
    h.metadataCache.getFileCache.mockReturnValue({} as ReturnType<typeof h.metadataCache.getFileCache>);
    expect(await h.makeInbox().sync()).toMatchObject({ saved: [], alreadyInVault: 1, failed: 0 });
    expect(h.files.size).toBe(1);
    expect(h.server.acks[0].body).toEqual({ vault_path: path });
  });

  it("recovers an unindexed note after a lost ack and a fresh inbox instance", async () => {
    const h = setup();
    h.server.setOverride((input) => input.method === "POST" ? { status: 503, body: {} } : null);
    const first = await h.inbox.sync();
    h.unindexed.add(first.saved[0]);
    h.server.setOverride(null);

    expect(await h.makeInbox().sync()).toMatchObject({ saved: [], alreadyInVault: 1, failed: 0 });
    expect(h.files.size).toBe(1);
    expect(h.server.acks[0].body).toEqual({ vault_path: first.saved[0] });
  });

  it("reconciles an external write made during the confirmation wait", async () => {
    const confirm = jest.fn();
    const h = setup({ settings: { askBeforeSaving: true }, confirm });
    const path = "Elsewhere/From phone.md";
    confirm.mockImplementation(async () => {
      await h.vault.create(path, "---\ncapture_id: cap_1\n---\nBody\n");
      h.unindexed.add(path);
      return true;
    });

    expect(await h.inbox.sync()).toMatchObject({ saved: [], alreadyInVault: 1, failed: 0 });
    expect(h.files.size).toBe(1);
    expect(h.server.acks[0].body).toEqual({ vault_path: path });
  });

  it("reconciles again after asynchronous folder creation", async () => {
    const h = setup();
    h.vault.createFolder.mockImplementationOnce(async () => {
      const path = "External.md";
      await h.vault.create(path, "---\ncapture_id: cap_1\n---\nBody\n");
      h.unindexed.add(path);
    });
    expect(await h.inbox.sync()).toMatchObject({ saved: [], alreadyInVault: 1, failed: 0 });
    expect(h.files.size).toBe(1);
    expect(h.server.acks[0].body).toEqual({ vault_path: "External.md" });
  });

  it("reconciles a write that arrives during a fallback read", async () => {
    const h = setup({ files: { "Unindexed.md": "Unrelated" } });
    h.unindexed.add("Unindexed.md");
    h.vault.read.mockImplementationOnce(async () => {
      await h.vault.create("External.md", "---\ncapture_id: cap_1\n---\nBody\n");
      return "Unrelated";
    });
    expect(await h.inbox.sync()).toMatchObject({ saved: [], alreadyInVault: 1, failed: 0 });
    expect(h.files.size).toBe(2);
    expect(h.server.acks[0].body).toEqual({ vault_path: "External.md" });
  });

  it("discards a fallback result if that file changed while it was being read", async () => {
    const h = setup({ files: { "External.md": "---\ncapture_id: cap_1\n---\nOld body" } });
    h.unindexed.add("External.md");
    h.vault.read.mockImplementationOnce(async file => {
      const old = h.files.get(file.path)!;
      h.files.set(file.path, "Unrelated replacement");
      h.emit("modify", file);
      return old;
    });
    const result = await h.inbox.sync();
    expect(result).toMatchObject({ alreadyInVault: 0, failed: 0 });
    expect(result.saved).toHaveLength(1);
    expect(h.files.get("External.md")).toBe("Unrelated replacement");
    expect(h.server.acks[0].body).toEqual({ vault_path: result.saved[0] });
  });

  it("reconciles identity when another writer wins the create race", async () => {
    const h = setup();
    const create = h.vault.create.getMockImplementation()!;
    h.vault.create.mockImplementationOnce(async (path, content) => {
      await create(path, content);
      throw new Error("File already exists.");
    });
    expect(await h.inbox.sync()).toMatchObject({ saved: [], alreadyInVault: 1, failed: 0 });
    expect(h.files.size).toBe(1);
    expect(h.server.acks[0].body).toEqual({ vault_path: [...h.files.keys()][0] });
  });

  it("does not acknowledge a new file deleted before create returns", async () => {
    const h = setup();
    const create = h.vault.create.getMockImplementation()!;
    h.vault.create.mockImplementation(async (path, content) => {
      const file = await create(path, content);
      h.files.delete(path);
      h.emit("delete", file);
      return file;
    });
    expect(await h.inbox.sync()).toMatchObject({ failed: 1 });
    expect(h.server.acks).toHaveLength(0);
    expect(h.files.size).toBe(0);
    expect(h.listeners.size).toBe(0);
  });

  it("reads YAML frontmatter identity, including CRLF and quoted IDs, not body text", async () => {
    const h = setup({ files: {
      "From URI.md": '\uFEFF---\r\ncapture_id: "cap_1"\r\ntags: [café, 日本語]\r\n---\r\nBody',
      "Unrelated.md": "Body\ncapture_id: cap_2\n",
    }, captures: [CAPTURE, { ...CAPTURE, id: "cap_2" }] });
    for (const path of h.files.keys()) h.unindexed.add(path);
    const result = await h.inbox.sync();
    expect(result).toMatchObject({ alreadyInVault: 1, failed: 0 });
    expect(result.saved).toHaveLength(1);
    expect(h.server.acks[0].body).toEqual({ vault_path: "From URI.md" });
  });

  it("scans 10,000 indexed files once per sync and reads each unknown file only once", async () => {
    const files = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`Note ${i}.md`, "Unrelated"]));
    const captures = Array.from({ length: 50 }, (_, i) => ({ ...CAPTURE, id: `cap_${i}`, title: `Capture ${i}` }));
    const h = setup({ files, captures });
    for (let i = 0; i < 20; i++) h.unindexed.add(`Note ${i}.md`);
    expect(await h.inbox.sync()).toMatchObject({ failed: 0 });
    expect(h.server.acks).toHaveLength(50);
    expect(h.vault.getMarkdownFiles).toHaveBeenCalledTimes(1);
    expect(h.metadataCache.getFileCache).toHaveBeenCalledTimes(10_000);
    // Twenty pre-existing unknowns plus read-back of fifty newly saved notes.
    expect(h.vault.read).toHaveBeenCalledTimes(70);
    expect(h.listeners.size).toBe(0);
  });

  it("stops at the unknown-file read budget, then recovers once metadata is ready", async () => {
    const files = Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`Note ${i}.md`, "Unrelated"]));
    const h = setup({ files });
    for (const path of h.files.keys()) h.unindexed.add(path);
    expect(await h.inbox.sync()).toMatchObject({ saved: [], failed: 1 });
    expect(h.vault.read).toHaveBeenCalledTimes(1024);
    expect(h.vault.create).not.toHaveBeenCalled();
    expect(h.server.acks).toHaveLength(0);
    expect(h.listeners.size).toBe(0);
    h.unindexed.clear();
    expect(await h.inbox.sync()).toMatchObject({ failed: 0 });
    expect(h.server.acks).toHaveLength(1);
  });

  it("never treats an unreadable or oversized unknown note as absent", async () => {
    const unreadable = setup({ files: { "Unknown.md": "Unrelated" } });
    unreadable.unindexed.add("Unknown.md");
    unreadable.vault.read.mockRejectedValue(new Error("Read failed"));
    expect(await unreadable.inbox.sync()).toMatchObject({ saved: [], failed: 1 });
    expect(unreadable.server.acks).toHaveLength(0);
    expect(unreadable.listeners.size).toBe(0);

    const large = setup({ files: { "Large.md": "x".repeat(1024 * 1024 + 1) } });
    large.unindexed.add("Large.md");
    expect(await large.inbox.sync()).toMatchObject({ saved: [], failed: 1 });
    expect(large.vault.read).not.toHaveBeenCalled();
    expect(large.server.acks).toHaveLength(0);
  });

  it("retries a failed acknowledgement on the next sync without a second note", async () => {
    const { inbox, vault, server, advance } = setup();
    server.setOverride((input) => input.method === "POST"
      ? { status: 503, body: { error: { code: "temporarily_unavailable", message: "Retry." } } }
      : null);

    const first = await inbox.sync();
    expect(first).toMatchObject({ failed: 1 });
    expect(first.saved).toHaveLength(1);

    server.setOverride(null);
    advance(PHONE_CAPTURE_MIN_SYNC_GAP_MS);
    const second = await inbox.sync();

    expect(vault.create).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ saved: [], alreadyInVault: 1 });
    expect(server.acks.map((a) => a.body)).toEqual([{ vault_path: first.saved[0] }]);
  });

  it("reports a failed save, keeps it pending and writes once on retry", async () => {
    const h = setup();
    h.vault.create.mockRejectedValueOnce(new Error("Disk full: private detail"));
    expect(await h.inbox.sync({ manual: true })).toMatchObject({ saved: [], failed: 1, unacknowledged: 0 });
    expect(h.notify).toHaveBeenLastCalledWith("Couldn't save 1 iOS capture. Sync again to retry.");
    expect(h.files.size).toBe(0);
    expect(h.server.acks).toHaveLength(0);
    expect(h.server.pending.size).toBe(1);

    expect((await h.inbox.sync({ manual: true })).saved).toHaveLength(1);
    expect(h.files.size).toBe(1);
    expect(h.server.acks).toHaveLength(1);
    expect(h.server.pending.size).toBe(0);
    expect(h.notify).toHaveBeenLastCalledWith("Saved 1 iOS capture to SystemSculpt/Inbox.");
  });

  it("distinguishes saved-but-unacknowledged and failed re-ack from an empty inbox", async () => {
    const h = setup();
    h.server.setOverride(input => input.method === "POST" ? { status: 503, body: {} } : null);
    const first = await h.inbox.sync({ manual: true });
    expect(first).toMatchObject({ failed: 1, unacknowledged: 1 });
    expect(h.notify).toHaveBeenLastCalledWith("Saved 1 iOS capture to SystemSculpt/Inbox. Delivery confirmation pending for 1 iOS capture already in this vault. Sync again to retry.");
    expect(await h.makeInbox().sync({ manual: true })).toMatchObject({ saved: [], failed: 1, unacknowledged: 1 });
    expect(h.notify).toHaveBeenLastCalledWith("Delivery confirmation pending for 1 iOS capture already in this vault. Sync again to retry.");
    expect(h.server.pending.size).toBe(1);
    h.server.setOverride(null);
    expect(await h.makeInbox().sync({ manual: true })).toMatchObject({ saved: [], alreadyInVault: 1, failed: 0, unacknowledged: 0 });
    expect(h.notify).toHaveBeenLastCalledWith("1 iOS capture is already in this vault.");
    expect(h.vault.create).toHaveBeenCalledTimes(1);
    expect(h.server.acks[0].body).toEqual({ vault_path: first.saved[0] });
  });

  it("reports both success and failure in a mixed batch, then retries only the unsaved note", async () => {
    const h = setup({ captures: [CAPTURE, { ...CAPTURE, id: "cap_2", title: "Second" }] });
    h.vault.create.mockRejectedValueOnce(new Error("Disk full: private detail"));
    expect(await h.inbox.sync({ manual: true })).toMatchObject({ failed: 1, unacknowledged: 0 });
    expect(h.notify).toHaveBeenLastCalledWith("Saved 1 iOS capture to SystemSculpt/Inbox. Couldn't save 1 iOS capture. Sync again to retry.");
    expect(h.files.size).toBe(1);
    expect(h.server.pending.size).toBe(1);
    expect(h.server.acks.map(a => a.id)).toEqual(["cap_2"]);
    await h.inbox.sync({ manual: true });
    expect(h.files.size).toBe(2);
    expect(h.server.acks.map(a => a.id)).toEqual(["cap_2", "cap_1"]);
  });

  it("does not report a deleted or unverifiable new note as saved", async () => {
    for (const failure of ["deleted", "unreadable"]) {
      const h = setup();
      const create = h.vault.create.getMockImplementation()!;
      h.vault.create.mockImplementation(async (path, content) => {
        const file = await create(path, content);
        if (failure === "deleted") { h.files.delete(path); h.emit("delete", file); }
        else h.vault.read.mockRejectedValue(new Error("Read failed: private detail"));
        return file;
      });
      expect(await h.inbox.sync({ manual: true })).toMatchObject({ saved: [], failed: 1, unacknowledged: 0 });
      expect(h.notify).toHaveBeenLastCalledWith("Couldn't save 1 iOS capture. Sync again to retry.");
      expect(h.server.acks).toHaveLength(0);
      expect(h.server.pending.size).toBe(1);
    }
  });

  it("keeps the real empty inbox message and stays quiet in the background", async () => {
    const h = setup({ captures: [] });
    await h.inbox.sync();
    expect(h.notify).not.toHaveBeenCalled();
    await h.inbox.sync({ manual: true });
    expect(h.notify).toHaveBeenLastCalledWith("No new iOS captures.");
  });

  it("includes saved progress when a later page cannot be checked", async () => {
    const h = setup();
    h.server.setOverride(input => input.method !== "GET" ? null : new URL(input.url).searchParams.has("after")
      ? { status: 503, body: {} }
      : { status: 200, body: { captures: [CAPTURE], next_cursor: "next" } });
    expect(await h.inbox.sync({ manual: true })).toMatchObject({ failed: 1, skipped: "unavailable" });
    expect(h.notify).toHaveBeenLastCalledWith("Saved 1 iOS capture to SystemSculpt/Inbox. Couldn't check for iOS captures. Try again in a moment.");
  });

  it("includes deferred captures alongside saved or unacknowledged notes", async () => {
    const h = setup({ captures: [CAPTURE, { ...CAPTURE, id: "cap_2" }], files: { "Existing.md": "---\ncapture_id: cap_1\n---\nBody" }, settings: { askBeforeSaving: true }, confirm: jest.fn(async () => false) });
    h.server.setOverride(input => input.method === "POST" ? { status: 503, body: {} } : null);
    expect(await h.inbox.sync({ manual: true })).toMatchObject({ failed: 1, unacknowledged: 1, deferred: 1 });
    expect(h.notify).toHaveBeenLastCalledWith("Delivery confirmation pending for 1 iOS capture already in this vault. iOS captures are waiting to be saved. Sync again to retry.");
  });

  it("asks before saving when enabled and asks again only on a manual sync", async () => {
    const confirm = jest.fn(async () => false);
    const { inbox, vault, server, advance } = setup({ settings: { askBeforeSaving: true }, confirm });

    expect(await inbox.sync()).toMatchObject({ saved: [], deferred: 1 });
    expect(confirm).toHaveBeenCalledWith([expect.objectContaining({ id: "cap_1" })], "SystemSculpt/Inbox");

    advance(PHONE_CAPTURE_MIN_SYNC_GAP_MS);
    expect(await inbox.sync()).toMatchObject({ deferred: 1 });
    expect(confirm).toHaveBeenCalledTimes(1);

    confirm.mockResolvedValueOnce(true);
    const manual = await inbox.sync({ manual: true });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(manual.saved).toHaveLength(1);
    expect(vault.create).toHaveBeenCalledTimes(1);
    expect(server.acks).toHaveLength(1);
  });

  it("does nothing when the inbox is off or the user is signed out", async () => {
    const off = setup({ settings: { enabled: false } });
    expect(await off.inbox.sync()).toMatchObject({ skipped: "disabled" });
    expect(off.server.requests).toHaveLength(0);

    const signedOut = setup({ settings: { licenseKey: " " } });
    expect(await signedOut.inbox.sync()).toMatchObject({ skipped: "signed_out" });
    expect(signedOut.server.requests).toHaveLength(0);
  });

  it("stays dormant until the account has used the iOS app", async () => {
    const { inbox, server, notify, checkLinked, onLinked, advance } = setup({
      settings: { linked: false },
      checkLinked: async () => false,
    });

    expect(await inbox.maybeSync()).toMatchObject({ saved: [], skipped: "not_linked" });
    advance(PHONE_CAPTURE_MIN_SYNC_GAP_MS);
    expect(await inbox.maybeSync()).toMatchObject({ skipped: "not_linked" });

    expect(server.requests).toHaveLength(0);
    expect(checkLinked).toHaveBeenCalledTimes(1);
    expect(onLinked).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("stays dormant when the link check fails", async () => {
    const { inbox, server, notify } = setup({
      settings: { linked: false },
      checkLinked: async () => { throw new Error("offline"); },
    });

    expect(await inbox.sync()).toMatchObject({ skipped: "not_linked" });
    expect(server.requests).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("starts saving and announces it once when the account becomes linked", async () => {
    let linkedOnServer = false;
    const { inbox, server, notify, onLinked, advance } = setup({
      settings: { linked: false },
      checkLinked: async () => linkedOnServer,
    });

    expect(await inbox.maybeSync()).toMatchObject({ skipped: "not_linked" });
    linkedOnServer = true;
    advance(PHONE_CAPTURE_LINK_CHECK_GAP_MS);

    const result = await inbox.maybeSync();
    expect(result?.saved).toEqual(["SystemSculpt/Inbox/Friday oat milk 2026-10-14.md"]);
    expect(onLinked).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls.map(([message]) => message)).toEqual([
      "iOS captures will be saved to SystemSculpt/Inbox.",
      "Saved 1 iOS capture to SystemSculpt/Inbox.",
    ]);

    advance(PHONE_CAPTURE_MIN_SYNC_GAP_MS);
    await inbox.maybeSync();
    expect(onLinked).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(server.requests.filter((r) => r.method === "GET")).toHaveLength(2);
  });

  it("polls right away without a notice when the account was linked before startup", async () => {
    const { inbox, server, notify, checkLinked } = setup({ captures: [] });

    expect(await inbox.maybeSync()).toMatchObject({ saved: [], failed: 0 });
    expect(checkLinked).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("checks right away when another read reports the link", async () => {
    let linkedOnServer = false;
    const { inbox, server, notify, onLinked } = setup({
      settings: { linked: false },
      checkLinked: async () => linkedOnServer,
    });

    expect(await inbox.maybeSync()).toMatchObject({ skipped: "not_linked" });
    linkedOnServer = true;

    const result = await inbox.linkReported();
    expect(result?.saved).toHaveLength(1);
    expect(onLinked).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("iOS captures will be saved to SystemSculpt/Inbox.");
    expect(inbox.linkReported()).toBeNull();
    expect(server.requests.filter((r) => r.method === "GET")).toHaveLength(1);
  });

  it("follows the cursor across pages", async () => {
    const second = { ...CAPTURE, id: "cap_2", title: "Dentist" };
    const { inbox, server } = setup({ captures: [] });
    server.setOverride((input) => {
      if (input.method !== "GET") return null;
      const after = new URL(input.url).searchParams.get("after");
      return after === "c1"
        ? { status: 200, body: { captures: [second], next_cursor: null } }
        : { status: 200, body: { captures: [CAPTURE], next_cursor: "c1" } };
    });
    const result = await inbox.sync();

    expect(result.saved).toEqual([
      "SystemSculpt/Inbox/Friday oat milk 2026-10-14.md",
      "SystemSculpt/Inbox/Dentist 2026-10-14.md",
    ]);
  });

  it("skips malformed captures and stops background polling when the plugin is too old", async () => {
    const { inbox, server, vault, advance, notify } = setup({
      captures: [{ id: "../evil", created_at: "x", markdown: 1 }],
    });
    expect(await inbox.sync()).toMatchObject({ saved: [], failed: 0 });
    expect(vault.create).not.toHaveBeenCalled();

    server.setOverride(() => ({ status: 426, body: { error: { code: "upgrade_required", message: "Update." } } }));
    advance(PHONE_CAPTURE_MIN_SYNC_GAP_MS);
    expect(await inbox.sync()).toMatchObject({ skipped: "unavailable" });
    const calls = server.requests.length;

    advance(PHONE_CAPTURE_MIN_SYNC_GAP_MS);
    expect(await inbox.sync()).toMatchObject({ skipped: "unavailable" });
    expect(server.requests).toHaveLength(calls);

    await inbox.sync({ manual: true });
    expect(server.requests).toHaveLength(calls + 1);
    expect(notify).toHaveBeenCalledWith("Update SystemSculpt to receive iOS captures.");
  });

  it("throttles background triggers and shares a running sync", async () => {
    const { inbox, server, advance } = setup({ captures: [] });

    const first = inbox.maybeSync();
    expect(first).not.toBeNull();
    expect(inbox.sync()).toBe(first);
    await first;
    expect(inbox.maybeSync()).toBeNull();

    advance(PHONE_CAPTURE_MIN_SYNC_GAP_MS);
    await inbox.maybeSync();
    expect(server.requests).toHaveLength(2);
  });
});
