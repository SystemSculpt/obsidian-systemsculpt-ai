import { TFile, TFolder, type App } from "obsidian";
import YAML from "yaml";
import { PhoneHandoffInbox, decodePhoneHandoff, type HandoffExecution, type PhoneHandoff } from "../PhoneHandoffInbox";
import { PHONE_CAPTURE_MIN_SYNC_GAP_MS } from "../PhoneCaptureInbox";
import type { PlatformRequestClient, PlatformRequestInput } from "../../../services/PlatformRequestClient";
import retryFixture from "../../../../testing/fixtures/retry-after.json";

jest.mock("obsidian", () => ({
  ...jest.requireActual("obsidian"),
  stringifyYaml: (value: unknown) => jest.requireActual("yaml").stringify(value),
  parseYaml: (value: string) => jest.requireActual("yaml").parse(value),
}));

const ID = "00000000-0000-4000-8000-000000000001";
const CAPTURE = "00000000-0000-4000-8000-000000000002";
const VAULT = "00000000-0000-4000-8000-000000000003";
const INSTANCE = "00000000-0000-4000-8000-000000000004";
const HANDOFF: PhoneHandoff = { id: ID, capture_id: CAPTURE, vault_id: VAULT, instruction: "Draft an agenda.\nKeep the full instruction.", agent: "claude_code", status: "pending", lease_expires_at: null };
const PATH = `SystemSculpt/Handoffs/${ID}.md`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
function setup(now?: () => number) {
  let settings = { licenseKey: "test-license", linked: true, autoRun: false, vaultId: VAULT };
  let handoff = { ...HANDOFF };
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const objects = new Map<string, TFile>();
  const listeners = new Map<string, Set<(file: TFile) => void>>();
  const emit = (event: string, file: TFile) => { for (const listener of listeners.get(event) ?? []) listener(file); };
  const fileAt = (path: string): TFile | null => {
    if (!files.has(path)) return null;
    if (!objects.has(path)) objects.set(path, new TFile({ path }));
    return objects.get(path)!;
  };
  const vault = {
    on: jest.fn((event: string, callback: (file: TFile) => void) => {
      const callbacks = listeners.get(event) ?? new Set();
      callbacks.add(callback);
      listeners.set(event, callbacks);
      return { event, callback };
    }),
    offref: jest.fn((ref: { event: string; callback: (file: TFile) => void }) => { listeners.get(ref.event)?.delete(ref.callback); }),
    getName: () => "QA vault",
    getAbstractFileByPath: (path: string) => fileAt(path) ?? (folders.has(path) ? new TFolder({ path }) : null),
    getMarkdownFiles: () => [...files.keys()].map(path => fileAt(path)!),
    createFolder: jest.fn(async (path: string) => { folders.add(path); }),
    create: jest.fn(async (path: string, text: string) => {
      if (files.has(path)) throw new Error("exists");
      files.set(path, text);
      return fileAt(path)!;
    }),
    read: jest.fn(async (file: TFile) => files.get(file.path)!),
    process: jest.fn(async (file: TFile, change: (text: string) => string) => {
      files.set(file.path, change(files.get(file.path)!));
      return files.get(file.path)!;
    }),
  };
  const app = { vault, metadataCache: { getFileCache: () => null } } as unknown as App;
  const requests: PlatformRequestInput[] = [];
  let override: ((request: PlatformRequestInput) => Response | Promise<Response> | undefined) | undefined;
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const requestClient = { request: jest.fn(async (input: PlatformRequestInput) => {
    requests.push(input);
    const overridden = await override?.(input);
    if (overridden) return overridden;
    const url = new URL(input.url);
    const body = input.body as Record<string, string>;
    if (url.pathname.endsWith("/capabilities")) return response({ capability: input.body });
    if (url.pathname.endsWith("/handoffs")) return response({ handoffs: handoff.status === "pending" ? [handoff] : [], next_cursor: null });
    if (url.pathname.endsWith(`/handoffs/${ID}`)) return response({ handoff });
    if (url.pathname.endsWith(`/captures/${CAPTURE}`)) return response({ capture: { id: CAPTURE, status: "delivered", title: "Meeting", markdown: "Untrusted source note." } });
    if (url.pathname.endsWith("/claim")) {
      handoff = { ...handoff, status: "claimed", lease_expires_at: body.lease_expires_at };
      return response({ handoff, lease_token: "opaque-token" });
    }
    if (url.pathname.endsWith("/progress")) {
      handoff = { ...handoff, status: body.status as PhoneHandoff["status"], lease_expires_at: body.lease_expires_at };
      return response({ handoff });
    }
    if (url.pathname.endsWith("/complete")) handoff.status = "completed";
    if (url.pathname.endsWith("/fail")) handoff.status = "failed";
    return response({ handoff });
  }) } as unknown as PlatformRequestClient;
  const execute = jest.fn(async (_execution: HandoffExecution) => "# Agenda\n\nDiscuss the launch.");
  const makeInbox = () => new PhoneHandoffInbox({ app, pluginVersion: "6.16.0", settings: () => settings, instanceId: INSTANCE,
    availableAgents: async () => ["systemsculpt", "claude_code"], execute, requestClient, now, baseUrl: "https://example.test/api/plugin" });
  return { inbox: makeInbox(), makeInbox, execute, files, vault, requests, response,
    move: (from: string, to: string) => {
      const file = fileAt(from)!;
      files.set(to, files.get(from)!);
      files.delete(from);
      objects.delete(from);
      file.path = to;
      objects.set(to, file);
      emit("rename", file);
    },
    emit,
    setSettings: (patch: Partial<typeof settings>) => { settings = { ...settings, ...patch }; },
    setHandoff: (patch: Partial<PhoneHandoff>) => { handoff = { ...handoff, ...patch }; },
    override: (value: typeof override) => { override = value; },
    calls: (suffix: string) => requests.filter(request => new URL(request.url).pathname.endsWith(suffix)),
  };
}

describe("PhoneHandoffInbox", () => {
  afterEach(() => { jest.useRealTimers(); });

  it.each(retryFixture.cases)("honors $name before polling again for JSON and gateway errors", async ({ header, milliseconds }) => {
    for (const body of ["{}", "<html>Gateway unavailable</html>"]) {
      let now = retryFixture.now;
      const t = setup(() => now);
      t.override(() => new Response(body, { status: 503, headers: header === null ? {} : { "Retry-After": header } }));
      await expect(t.inbox.poll()).rejects.toThrow();
      expect(t.requests).toHaveLength(1);
      if (milliseconds !== null && milliseconds > 0) {
        now += milliseconds - 1;
        await t.inbox.poll();
        expect(t.requests).toHaveLength(1);
        now += 1;
      }
      await expect(t.inbox.poll()).rejects.toThrow();
      expect(t.requests).toHaveLength(2);
      t.inbox.dispose();
    }
  });

  it("does not discard an overflowing delta or add a handoff wait ceiling", async () => {
    let now = retryFixture.now;
    const t = setup(() => now);
    t.override(() => new Response("{}", { status: 503, headers: { "Retry-After": "9".repeat(400) } }));
    await expect(t.inbox.poll()).rejects.toThrow();
    now += 48 * 60 * 60_000;
    await t.inbox.poll();
    expect(t.requests).toHaveLength(1);
    t.inbox.dispose();
  });

  it("stays dormant until this account has used iOS", async () => {
    const t = setup();
    t.setSettings({ linked: false });
    await t.inbox.poll();
    expect(t.requests).toEqual([]);
    t.setSettings({ linked: true, licenseKey: "" });
    await t.inbox.poll();
    expect(t.requests).toEqual([]);
  });

  it("advertises actual agents and waits for Run with full instruction/source", async () => {
    const t = setup();
    await t.inbox.poll();
    expect(t.calls("/capabilities")[0].body).toEqual({ vault_id: VAULT, plugin_instance_id: INSTANCE, vault_name: "QA vault", agents: ["systemsculpt", "claude_code"] });
    expect(t.inbox.items[0]).toMatchObject({ instruction: HANDOFF.instruction, state: "pending", source: { markdown: "Untrusted source note." } });
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.calls("/claim")).toHaveLength(0);
    expect(t.files.size).toBe(0);
    await t.inbox.run(ID);
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(t.calls("/complete")[0].body).toMatchObject({ result_summary: "# Agenda\n\nDiscuss the launch.", vault_path: PATH, lease_token: "opaque-token" });
    expect(t.files.get(PATH)).toContain("handoff_state: completed");
    expect(t.files.get(PATH)).not.toMatch(/^capture_id:/m);
    expect(t.inbox.items[0]).toMatchObject({ state: "completed", resultPath: PATH });
  });

  it("opt-in skips only Run and reports the agent's approval wait", async () => {
    const t = setup();
    const wait = deferred<string>();
    const started = deferred<void>();
    t.setSettings({ autoRun: true });
    t.execute.mockImplementation(async execution => { execution.onApproval(true); started.resolve(); return wait.promise; });
    await t.inbox.poll();
    await started.promise;
    expect(t.inbox.items[0].state).toBe("needs_approval");
    wait.resolve("Done");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(t.calls("/progress").map(call => (call.body as { status: string }).status)).toContain("needs_approval");
    expect(t.calls("/complete")).toHaveLength(1);
    t.inbox.dispose();
  });

  it("does not execute duplicate Run clicks", async () => {
    const t = setup();
    const wait = deferred<string>();
    t.execute.mockReturnValue(wait.promise);
    await t.inbox.poll();
    const run = t.inbox.run(ID);
    await t.inbox.run(ID);
    wait.resolve("Done");
    await run;
    expect(t.calls("/claim")).toHaveLength(1);
    expect(t.execute).toHaveBeenCalledTimes(1);
  });

  it("reconciles a verified result after a lost completion response without reexecution", async () => {
    const t = setup();
    t.override(input => { if (input.url.endsWith("/complete")) throw new Error("lost connection"); });
    await t.inbox.poll();
    await t.inbox.run(ID);
    expect(t.files.get(PATH)).toContain("handoff_state: completed");
    expect(t.calls("/fail")).toHaveLength(0);
    t.inbox.dispose();
    t.override(undefined);
    t.setHandoff({ status: "pending", lease_expires_at: null });
    const restarted = t.makeInbox();
    await restarted.poll();
    await restarted.run(ID);
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(restarted.items[0].state).toBe("completed");
  });

  it("reconciles a completion that committed before its response was lost", async () => {
    const t = setup();
    t.override(input => {
      if (input.url.endsWith("/complete")) {
        t.setHandoff({ status: "completed" });
        throw new Error("response lost after commit");
      }
    });
    await t.inbox.poll();
    await t.inbox.run(ID);
    expect(t.inbox.items[0].state).toBe("failed");
    t.override(undefined);
    await t.inbox.poll();
    expect(t.calls(`/handoffs/${ID}`)).toHaveLength(1);
    expect(t.inbox.items[0]).toMatchObject({ state: "completed", resultPath: PATH });
    expect(t.inbox.items[0].message).toBeUndefined();
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(t.calls("/complete")).toHaveLength(1);
    expect(t.calls("/fail")).toHaveLength(0);
  });

  it("discards an old account's delayed status reconciliation", async () => {
    const t = setup();
    t.override(input => { if (input.url.endsWith("/complete")) throw new Error("offline"); });
    await t.inbox.poll();
    await t.inbox.run(ID);
    const checking = deferred<void>();
    const reply = deferred<Response>();
    t.override(input => {
      if (input.url.endsWith(`/handoffs/${ID}`)) { checking.resolve(); return reply.promise; }
    });
    const poll = t.inbox.poll();
    await checking.promise;
    t.setSettings({ licenseKey: "new-account", linked: false });
    await t.inbox.poll();
    const rejected = expect(poll).rejects.toThrow("account changed");
    reply.resolve(t.response({ handoff: { ...HANDOFF, status: "completed" } }));
    await rejected;
    expect(t.inbox.items).toEqual([]);
    expect(t.calls("/complete")).toHaveLength(1);
  });

  it("rejects a foreign handoff in a status reconciliation response", async () => {
    const t = setup();
    t.override(input => { if (input.url.endsWith("/complete")) throw new Error("offline"); });
    await t.inbox.poll();
    await t.inbox.run(ID);
    t.override(input => input.url.endsWith(`/handoffs/${ID}`)
      ? t.response({ handoff: { ...HANDOFF, id: CAPTURE, status: "completed" } }) : undefined);
    await expect(t.inbox.poll()).rejects.toThrow("Invalid handoff status");
    expect(t.inbox.items[0].state).toBe("failed");
    expect(t.inbox.items[0].resultPath).toBeUndefined();
  });

  it("finds a moved completed receipt when reconciling the server status", async () => {
    const t = setup();
    t.override(input => {
      if (input.url.endsWith("/complete")) {
        t.setHandoff({ status: "completed" });
        throw new Error("response lost after commit");
      }
    });
    await t.inbox.poll();
    await t.inbox.run(ID);
    t.move(PATH, "Archive/Agenda.md");
    t.override(undefined);
    await t.inbox.poll();
    expect(t.inbox.items[0]).toMatchObject({ state: "completed", resultPath: "Archive/Agenda.md" });
    expect(t.execute).toHaveBeenCalledTimes(1);
  });

  it("does not claim a verified local result when the completed receipt was removed", async () => {
    const t = setup();
    t.override(input => {
      if (input.url.endsWith("/complete")) {
        t.setHandoff({ status: "completed" });
        throw new Error("response lost after commit");
      }
    });
    await t.inbox.poll();
    await t.inbox.run(ID);
    t.files.delete(PATH);
    t.override(undefined);
    await t.inbox.poll();
    expect(t.inbox.items[0].state).toBe("failed");
    expect(t.inbox.items[0].resultPath).toBeUndefined();
  });

  it("never replays an interrupted handoff whose start receipt moved before restart", async () => {
    const t = setup();
    t.execute.mockImplementationOnce(async () => {
      t.move(PATH, "Archive/Started.md");
      throw new Error("interrupted");
    });
    t.override(input => { if (input.url.endsWith("/fail")) throw new Error("offline"); });
    await t.inbox.poll();
    await t.inbox.run(ID);
    t.inbox.dispose();
    t.setHandoff({ status: "pending", lease_expires_at: null });
    t.override(undefined);
    const restarted = t.makeInbox();
    await restarted.poll();
    await restarted.run(ID);
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(t.files.has(PATH)).toBe(false);
    expect(t.files.get("Archive/Started.md")).toContain("handoff_state: started");
    expect(restarted.items[0].state).toBe("failed");
  });

  it("reports a moved completed receipt after reclamation without reexecution", async () => {
    const t = setup();
    t.override(input => { if (input.url.endsWith("/complete")) throw new Error("offline"); });
    await t.inbox.poll();
    await t.inbox.run(ID);
    t.move(PATH, "Archive/Agenda.md");
    t.inbox.dispose();
    t.setHandoff({ status: "pending", lease_expires_at: null });
    t.override(undefined);
    const restarted = t.makeInbox();
    await restarted.poll();
    await restarted.run(ID);
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(t.calls("/complete").at(-1)?.body).toMatchObject({ vault_path: "Archive/Agenda.md" });
    expect(t.files.has(PATH)).toBe(false);
    expect(restarted.items[0]).toMatchObject({ state: "completed", resultPath: "Archive/Agenda.md" });
  });

  it("uses the latest path when a receipt moves while its identity is being read", async () => {
    const t = setup();
    t.override(input => { if (input.url.endsWith("/complete")) throw new Error("offline"); });
    await t.inbox.poll();
    await t.inbox.run(ID);
    t.move(PATH, "Archive/Agenda.md");
    t.inbox.dispose();
    t.setHandoff({ status: "pending", lease_expires_at: null });
    t.override(undefined);
    t.vault.read.mockImplementationOnce(async file => {
      const contents = t.files.get(file.path)!;
      t.move(file.path, "Archive/Renamed.md");
      return contents;
    });
    const restarted = t.makeInbox();
    await restarted.poll();
    await restarted.run(ID);
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(restarted.items[0]).toMatchObject({ state: "completed", resultPath: "Archive/Renamed.md" });
    expect(t.vault.offref).toHaveBeenCalledTimes(t.vault.on.mock.calls.length);
  });

  it("fails closed when a moved receipt cannot be read", async () => {
    const t = setup();
    t.execute.mockRejectedValueOnce(new Error("interrupted"));
    await t.inbox.poll();
    await t.inbox.run(ID);
    t.move(PATH, "Archive/Started.md");
    t.setHandoff({ status: "pending", lease_expires_at: null });
    t.vault.read.mockRejectedValueOnce(new Error("vault temporarily unavailable"));
    const restarted = t.makeInbox();
    await restarted.poll();
    await restarted.run(ID);
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(t.files.has(PATH)).toBe(false);
    expect(restarted.items[0].state).toBe("failed");
    expect(t.vault.offref).toHaveBeenCalledTimes(t.vault.on.mock.calls.length);
  });

  it("does not report completion when the result note was renamed to a non-Markdown path", async () => {
    const t = setup();
    t.execute.mockImplementation(async () => { t.move(PATH, "Archive/Agenda.txt"); return "Result"; });
    await t.inbox.poll();
    await t.inbox.run(ID);
    expect(t.calls("/complete")).toHaveLength(0);
    expect(t.inbox.items[0].state).toBe("failed");
  });

  it("never replays an interrupted native turn after lease reclamation", async () => {
    const t = setup();
    t.execute.mockRejectedValue(new Error("native process interrupted (secret must not leave client)"));
    await t.inbox.poll();
    await t.inbox.run(ID);
    expect(t.files.get(PATH)).toContain("handoff_state: started");
    t.setHandoff({ status: "pending" });
    const restarted = t.makeInbox();
    await restarted.poll();
    await restarted.run(ID);
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(t.calls("/fail"))).not.toContain("secret must not leave client");
  });

  it.each(["handoff_cancelled", "lease_lost", "not_found"])("stops on %s without publishing a result", async code => {
    jest.useFakeTimers();
    const t = setup();
    const started = deferred<void>();
    t.execute.mockImplementation(async execution => {
      started.resolve();
      return new Promise(resolve => execution.signal.addEventListener("abort", () => resolve("Late result")));
    });
    await t.inbox.poll();
    const run = t.inbox.run(ID);
    await started.promise;
    t.override(input => input.url.endsWith("/progress") ? t.response({ error: { code, message: "fenced" } }, code === "not_found" ? 404 : 409) : undefined);
    await jest.advanceTimersByTimeAsync(PHONE_CAPTURE_MIN_SYNC_GAP_MS);
    await run;
    expect(t.calls("/complete")).toHaveLength(0);
    expect(t.files.get(PATH)).not.toContain("Late result");
    expect(t.inbox.items[0].state).toBe("failed");
  });

  it("stops after a lost heartbeat without converting transport uncertainty into terminal failure", async () => {
    jest.useFakeTimers();
    const t = setup();
    const started = deferred<void>();
    t.execute.mockImplementation(async execution => {
      started.resolve();
      return new Promise((_resolve, reject) => execution.signal.addEventListener("abort", () => reject(new Error("native run cancelled"))));
    });
    await t.inbox.poll();
    const run = t.inbox.run(ID);
    await started.promise;
    t.override(input => { if (input.url.endsWith("/progress")) throw new Error("heartbeat response lost"); });
    await jest.advanceTimersByTimeAsync(PHONE_CAPTURE_MIN_SYNC_GAP_MS);
    await run;
    expect(t.calls("/complete")).toHaveLength(0);
    expect(t.calls("/fail")).toHaveLength(0);
    expect(t.inbox.items[0].state).toBe("failed");
    expect(t.files.get(PATH)).toContain("handoff_state: started");
  });

  it("does not send progress after the terminal completion request starts", async () => {
    jest.useFakeTimers();
    const t = setup();
    const completing = deferred<void>();
    const reply = deferred<Response>();
    t.override(input => {
      if (input.url.endsWith("/complete")) { completing.resolve(); return reply.promise; }
    });
    await t.inbox.poll();
    const run = t.inbox.run(ID);
    await completing.promise;
    try {
      await jest.advanceTimersByTimeAsync(PHONE_CAPTURE_MIN_SYNC_GAP_MS);
      expect(t.calls("/progress")).toHaveLength(1);
    } finally {
      reply.resolve(t.response({ handoff: { ...HANDOFF, status: "completed" } }));
      await run;
    }
    expect(t.inbox.items[0].state).toBe("completed");
  });

  it("cancels on account change and never reports the old work using the new key", async () => {
    const t = setup();
    const started = deferred<void>();
    t.execute.mockImplementation(async execution => {
      started.resolve();
      return new Promise(resolve => execution.signal.addEventListener("abort", () => resolve("Late result")));
    });
    await t.inbox.poll();
    const run = t.inbox.run(ID);
    await started.promise;
    t.setSettings({ licenseKey: "new-account", linked: false });
    await t.inbox.poll();
    await run;
    expect(t.inbox.items).toEqual([]);
    expect(t.calls("/complete")).toHaveLength(0);
    expect(t.calls("/fail")).toHaveLength(0);
  });

  it("preserves edits to the result note made during execution", async () => {
    const t = setup();
    t.execute.mockImplementation(async () => { t.files.set(PATH, "My edits"); return "Result"; });
    await t.inbox.poll();
    await t.inbox.run(ID);
    expect(t.files.get(PATH)).toBe("My edits");
    expect(t.calls("/complete")).toHaveLength(0);
  });

  it("refuses occupied result paths and unavailable/foreign agents", async () => {
    const t = setup();
    t.files.set(PATH, "A person's existing note");
    await t.inbox.poll();
    await t.inbox.run(ID);
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.files.get(PATH)).toBe("A person's existing note");
    t.setHandoff({ status: "pending", agent: "codex" });
    const unavailable = t.makeInbox();
    await unavailable.poll();
    expect(unavailable.items).toEqual([]);
    t.setHandoff({ agent: "claude_code", vault_id: INSTANCE });
    await unavailable.poll();
    expect(unavailable.items).toEqual([]);
  });

  it("starts pagination from the beginning on every poll and accepts additive fields", async () => {
    const t = setup();
    t.override(input => {
      const url = new URL(input.url);
      if (!url.pathname.endsWith("/handoffs")) return;
      return t.response(url.searchParams.has("after")
        ? { handoffs: [{ ...HANDOFF, future: true }], next_cursor: null }
        : { handoffs: [], next_cursor: "page-2" });
    });
    await t.inbox.poll();
    await t.inbox.poll();
    expect(t.calls("/handoffs").map(input => new URL(input.url).searchParams.get("after"))).toEqual([null, "page-2", null, "page-2"]);
    expect(t.inbox.items).toHaveLength(1);
    expect(decodePhoneHandoff({ ...HANDOFF, agent: "future-agent" })).toBeNull();
    expect(decodePhoneHandoff({ ...HANDOFF, id: "../../elsewhere" })).toBeNull();
  });

  it("keeps a readable complete result and no credentials in its receipt", async () => {
    const t = setup();
    await t.inbox.poll();
    await t.inbox.run(ID);
    const note = t.files.get(PATH)!;
    const frontmatter = YAML.parse(/^---\n([\s\S]*?)\n---/.exec(note)![1]);
    expect(frontmatter.handoff_result).toBe("# Agenda\n\nDiscuss the launch.");
    expect(note).not.toContain("test-license");
    expect(note).not.toContain("opaque-token");
  });
});
