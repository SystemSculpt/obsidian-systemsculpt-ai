import { TFile, TFolder, type App } from "obsidian";
import YAML from "yaml";
import {
  PHONE_CAPTURE_MIN_SYNC_GAP_MS,
  PhoneCaptureInbox,
  type PhoneCaptureSettings,
} from "../PhoneCaptureInbox";
import type { PlatformRequestClient, PlatformRequestInput } from "../../../services/PlatformRequestClient";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  const YAML = jest.requireActual("yaml");
  return { ...actual, stringifyYaml: (value: unknown) => YAML.stringify(value) };
});

function fakeVault(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const folders = new Set<string>();
  const vault = {
    getAbstractFileByPath: (path: string) => {
      if (files.has(path)) return new TFile({ path });
      if (folders.has(path)) return new TFolder({ path });
      return null;
    },
    createFolder: jest.fn(async (path: string) => { folders.add(path); }),
    create: jest.fn(async (path: string, content: string) => {
      if (files.has(path)) throw new Error("File already exists.");
      files.set(path, content);
      return new TFile({ path });
    }),
    getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith(".md")).map((path) => new TFile({ path })),
  };
  const metadataCache = {
    getFileCache: (file: TFile) => {
      const match = /^---\n([\s\S]*?)---\n/.exec(files.get(file.path) ?? "");
      return match ? { frontmatter: YAML.parse(match[1]) } : null;
    },
  };
  return { app: { vault, metadataCache } as unknown as App, files, vault };
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
}> = {}) {
  const { app, files, vault } = fakeVault(options.files);
  const server = fakeServer(options.captures ?? [CAPTURE]);
  let now = 1_000_000;
  const settings: PhoneCaptureSettings = {
    licenseKey: "lic_test",
    enabled: true,
    folder: "",
    askBeforeSaving: false,
    ...options.settings,
  };
  const notify = jest.fn();
  const confirm = options.confirm ?? jest.fn(async () => true);
  const inbox = new PhoneCaptureInbox({
    app,
    settings: () => settings,
    pluginVersion: "6.12.0",
    confirm,
    notify,
    requestClient: server.client,
    baseUrl: "https://api.example.test/api/plugin",
    now: () => now,
  });
  return { inbox, files, vault, server, notify, confirm, advance: (ms: number) => { now += ms; } };
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
