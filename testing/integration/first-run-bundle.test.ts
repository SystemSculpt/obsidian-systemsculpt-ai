/**
 * @jest-environment jsdom
 *
 * A new user's first run through the exact production bundle: a fresh vault
 * with empty settings opens chat, signs up from chat's free-start offer in
 * the browser, and gets the first streamed answer; then each first-turn
 * failure a new account can hit. Only host edges are faked: one SystemSculpt
 * server behind Obsidian's requestUrl and window.fetch, the browser handoff,
 * an in-memory vault, and plugin storage. The bundle's own request client,
 * agent transport, account connection, chat storage, and views run unchanged.
 * The mock host has no Node `require`, so desktop finds neither Claude Code
 * nor Codex, as on a computer without them. Run `npm run build` first.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { App, Platform, TFile, TFolder, WorkspaceLeaf, requestUrl } from "obsidian";
import { captureStartupIdentity, expectProductionStartupIdentity } from "./startup-identity-assertions";

const BUNDLE_PATH = path.resolve(__dirname, "..", "..", "main.js");
const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "manifest.json");
const LICENSE_KEY = "first-run-license";
const ACCESS_TOKEN = "fixture.access.signature";
const QUESTION = "What is in my vault?";
const ANSWER = "Your vault has three project notes.";
const STARTER_CREDITS = 500;

type Reply = Readonly<{ status: number; json?: unknown; stream?: true }>;
type ServerRequest = Readonly<{
  via: "requestUrl" | "fetch";
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: any;
}>;

/** Real fetch Responses for the host: jsdom has none and the shared shim has no body stream. */
const hostFetch = vm.runInThisContext("({ Response, Headers })") as {
  Response: typeof Response;
  Headers: typeof Headers;
};

/**
 * The SystemSculpt API as a new account meets it: sign-up completes with a
 * starter license, and the first turn streams an answer. A test queues a
 * one-shot reply on a path, or takes the network offline, to fail one step.
 */
class FakeSystemSculpt {
  readonly requests: ServerRequest[] = [];
  readonly unexpected: string[] = [];
  online = true;
  credits = STARTER_CREDITS;
  /** Holds each answer after its first words until `finishAnswer`. */
  holdAnswers = false;
  phoneHandoff = false;
  private handoffVault = "";
  readonly handoff = {
    id: "00000000-0000-4000-8000-000000000059", capture_id: "00000000-0000-4000-8000-000000000058",
    instruction: "Summarize this phone capture.", agent: "systemsculpt", status: "pending", lease_expires_at: null as string | null,
    result_summary: null as string | null, vault_path: null as string | null,
  };
  private readonly failures = new Map<string, Reply>();
  private conversationId = "";
  private turns = 0;
  private releaseAnswer: (() => void) | null = null;

  constructor(private readonly manifest: { id: string; version: string }) {}

  failNext(path: string, reply: Reply): void {
    this.failures.set(path, reply);
  }

  finishAnswer(): void {
    this.releaseAnswer?.();
    this.releaseAnswer = null;
  }

  paths(): string[] {
    return this.requests.map(({ path }) => path);
  }

  answer(request: ServerRequest): Reply | null {
    this.requests.push(request);
    if (!this.online) return null;
    const failure = this.failures.get(request.path);
    if (failure) {
      this.failures.delete(request.path);
      return failure;
    }
    if (this.phoneHandoff) {
      const handoff = () => ({ ...this.handoff, vault_id: this.handoffVault });
      if (request.path === "/api/plugin/handoffs/capabilities") {
        this.handoffVault = request.body.vault_id;
        return { status: 200, json: { ok: true } };
      }
      if (request.path === "/api/plugin/handoffs") return { status: 200, json: { handoffs: this.handoff.status === "pending" ? [handoff()] : [], next_cursor: null } };
      if (request.path === `/api/plugin/captures/${this.handoff.capture_id}`) return { status: 200, json: { capture: { id: this.handoff.capture_id, title: "Phone source", markdown: "Three project notes.", status: "ready" } } };
      if (request.path === `/api/plugin/handoffs/${this.handoff.id}`) return { status: 200, json: { handoff: handoff() } };
      if (request.path === `/api/plugin/handoffs/${this.handoff.id}/claim`) {
        Object.assign(this.handoff, { status: "claimed", lease_expires_at: request.body.lease_expires_at });
        return { status: 200, json: { handoff: handoff(), lease_token: "fixture-lease" } };
      }
      if (request.path === `/api/plugin/handoffs/${this.handoff.id}/progress`) {
        Object.assign(this.handoff, { status: request.body.status, lease_expires_at: request.body.lease_expires_at });
        return { status: 200, json: { handoff: handoff() } };
      }
      if (request.path === `/api/plugin/handoffs/${this.handoff.id}/complete`) {
        Object.assign(this.handoff, { status: "completed", result_summary: request.body.result_summary, vault_path: request.body.vault_path });
        return { status: 200, json: { handoff: handoff() } };
      }
    }
    switch (request.path) {
      case "/api/plugin/releases/latest":
        return { status: 200, json: {
          contract_version: "plugin-release-v1",
          plugin_id: this.manifest.id,
          latest_version: this.manifest.version,
          release_url: `https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/tag/${this.manifest.version}`,
          published_at: "2026-10-24T00:00:00.000Z",
        } };
      case "/api/plugin/auth/poll":
        return { status: 200, json: {
          status: "ok",
          license_key: LICENSE_KEY,
          account: { name: "New User", email: "new-user@example.test" },
        } };
      case "/api/plugin/license/validate":
        return { status: 200, json: {
          contract_version: "admission-v1", code: "allowed", message: "License admitted.", request_id: "req_first_run",
        } };
      case "/api/plugin/credits/balance":
        return { status: 200, json: {
          included_remaining: 0,
          add_on_remaining: this.credits,
          total_remaining: this.credits,
          included_per_month: 0,
          included_credits_entitled: false,
          usage_class: "customer",
          cycle_anchor_at: "2026-10-01T00:00:00.000Z",
          cycle_started_at: "2026-10-01T00:00:00.000Z",
          cycle_ends_at: "2026-11-01T00:00:00.000Z",
          turn_in_flight_until: null,
        } };
      case "/api/plugin/connectivity":
        return { status: 200, json: { ok: true } };
      case "/api/plugin/agent/bootstrap":
        this.conversationId = request.body.conversation_id;
        return { status: 200, json: {
          contract_version: "thin-agent-v1",
          conversation_id: this.conversationId,
          session: { id: "session_0123456789abcdef0123456789abcdef" },
          access: { token: ACCESS_TOKEN, expires_at: "2030-01-01T00:01:00.000Z" },
          client_input_limits: {
            image_mime_types: ["image/png", "image/jpeg", "image/webp"],
            max_content_blocks_per_message: 16,
            max_images_per_turn: 6,
            max_image_bytes: 6 * 1024 * 1024,
            max_total_image_bytes: 16 * 1024 * 1024,
            max_text_bytes_per_block: 1024 * 1024,
            max_total_text_bytes: 2 * 1024 * 1024,
            max_document_bytes: 25 * 1024 * 1024,
          },
          accepted_capabilities: [{ id: "obsidian.vault", version: 1 }],
        } };
      case "/api/plugin/agent/connect/get-messages":
        return { status: 200, json: {
          type: "systemsculpt.agent.event.v1",
          version: 1,
          kind: "session_snapshot",
          conversation_id: this.conversationId,
          messages: [],
          run_state: { version: 1, cursor: 0, state: "idle" },
        } };
      case "/api/plugin/agent/turn":
        return { status: 200, stream: true };
      default:
        this.unexpected.push(`${request.method} ${request.path}`);
        return { status: 404, json: { error: { code: "not_found", message: "Not found." } } };
    }
  }

  /** The server's turn stream: acknowledgement, the run, the answer in two snapshots, and the end. */
  async *answerFrames(command: Record<string, any>): AsyncGenerator<Record<string, unknown>> {
    this.turns += 1;
    const user = command.user_message;
    const requestId = command.request_id;
    const runId = `run_${String(this.turns).padStart(32, "0")}`;
    const event = { type: "systemsculpt.agent.event.v1", version: 1, conversation_id: this.conversationId };
    let sequence = 0;
    const order = () => ({ snapshot_epoch: this.turns, snapshot_sequence: ++sequence });
    const assistant = (text: string) => ({
      id: `assistant-first-run-${this.turns}`,
      role: "assistant",
      parts: [{ type: "text", text }],
    });
    const queues = { queued_request_ids: [], cancelled_queued_request_ids: [] };
    yield { ...event, kind: "command_ack", request_id: requestId, command_kind: "submit", status: "accepted" };
    yield {
      ...event, kind: "session_snapshot", ...order(), ...queues, messages: [user],
      run_state: { version: 1, cursor: 1, state: "running", request_id: requestId, run_id: runId, root_message_id: user.id },
    };
    yield { ...event, kind: "assistant_snapshot", request_id: requestId, ...order(), message: assistant("Your vault has") };
    if (this.holdAnswers) await new Promise<void>((resolve) => { this.releaseAnswer = resolve; });
    yield { ...event, kind: "assistant_snapshot", request_id: requestId, ...order(), message: assistant(ANSWER) };
    yield {
      ...event, kind: "session_snapshot", ...order(), ...queues, messages: [user, assistant(ANSWER)],
      run_state: { version: 1, cursor: 2, state: "idle" },
    };
    yield {
      ...event, kind: "terminal", request_id: requestId,
      terminal: { version: 1, run_id: runId, root_message_id: user.id, outcome: "succeeded", code: "completed" },
    };
  }
}

function jsonBody(body: unknown): unknown {
  return typeof body === "string" && body ? JSON.parse(body) : undefined;
}

/** Obsidian's network edges, both answered by `server`. */
function installNetwork(server: FakeSystemSculpt): void {
  jest.mocked(requestUrl).mockImplementation((async (input: any) => {
    const reply = server.answer({
      via: "requestUrl",
      method: input.method ?? "GET",
      path: new URL(input.url).pathname,
      headers: input.headers ?? {},
      body: jsonBody(input.body),
    });
    if (!reply) throw new Error("net::ERR_INTERNET_DISCONNECTED");
    // requestUrl buffers a turn stream: the whole answer arrives at once.
    let text = JSON.stringify(reply.json ?? {});
    if (reply.stream) {
      text = "";
      for await (const frame of server.answerFrames(jsonBody(input.body) as Record<string, any>)) {
        text += `data: ${JSON.stringify(frame)}\n\n`;
      }
    }
    const bytes = new TextEncoder().encode(text);
    return {
      status: reply.status,
      headers: { "content-type": reply.stream ? "text/event-stream" : "application/json" },
      text,
      json: reply.json,
      arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }) as never);
  jest.spyOn(window, "fetch").mockImplementation(async (input, init) => {
    const body = jsonBody(init?.body) as Record<string, any> | undefined;
    const reply = server.answer({
      via: "fetch",
      method: init?.method ?? "GET",
      path: new URL(String(input)).pathname,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    if (!reply) throw new TypeError("Failed to fetch");
    if (!reply.stream) {
      return new hostFetch.Response(JSON.stringify(reply.json ?? {}), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    }
    const encoder = new TextEncoder();
    const frames = server.answerFrames(body!);
    return new hostFetch.Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await frames.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  });
}

/** An in-memory vault with this plugin installed in its config folder. */
function installVault(app: any, pluginId: string): Map<string, string | ArrayBuffer> {
  const bundle = readFileSync(BUNDLE_PATH);
  const files = new Map<string, string | ArrayBuffer>([[
    `.obsidian/plugins/${pluginId}/main.js`,
    bundle.buffer.slice(bundle.byteOffset, bundle.byteOffset + bundle.byteLength),
  ]]);
  const folders = new Set([".obsidian", ".obsidian/plugins", `.obsidian/plugins/${pluginId}`]);
  const key = (value: string) => value.replace(/^\/+/, "");
  const text = (value: string) => {
    const data = files.get(key(value));
    if (typeof data !== "string") throw new Error(`ENOENT: ${value}`);
    return data;
  };
  const fileObjects = new Map<string, TFile>();
  const fileAt = (value: string) => {
    const name = key(value);
    let file = fileObjects.get(name);
    if (!file) { file = new TFile({ path: name } as never); fileObjects.set(name, file); }
    return file;
  };
  const { vault } = app;
  const { adapter } = vault;
  vault.configDir = ".obsidian";
  vault.getAbstractFileByPath = jest.fn((value: string) => {
    if (files.has(key(value))) return fileAt(value);
    return folders.has(key(value)) ? new TFolder({ path: key(value) } as never) : null;
  });
  vault.create = jest.fn(async (value: string, data: string) => {
    if (files.has(key(value))) throw new Error("File already exists.");
    files.set(key(value), data);
    return fileAt(value);
  });
  vault.createFolder = jest.fn(async (value: string) => { folders.add(key(value)); });
  vault.read = jest.fn(async (file: TFile) => text(file.path));
  vault.cachedRead = vault.read;
  vault.getMarkdownFiles = jest.fn(() => [...files.keys()].filter(value => value.endsWith(".md")).map(fileAt));
  vault.process = jest.fn(async (file: TFile, transform: (value: string) => string) => { const next = transform(text(file.path)); files.set(key(file.path), next); return next; });
  vault.modify = jest.fn(async (file: TFile, data: string) => { files.set(key(file.path), data); });
  adapter.exists = jest.fn(async (value: string) => files.has(key(value)) || folders.has(key(value)));
  adapter.read = jest.fn(async (value: string) => text(value));
  adapter.write = jest.fn(async (value: string, data: string) => { files.set(key(value), data); });
  adapter.mkdir = jest.fn(async (value: string) => { folders.add(key(value)); });
  adapter.list = jest.fn(async (value: string) => {
    const prefix = key(value) ? `${key(value)}/` : "";
    const children = (paths: Iterable<string>) => [...paths].filter((entry) =>
      entry.startsWith(prefix) && !entry.slice(prefix.length).includes("/"));
    return { files: children(files.keys()), folders: children(folders) };
  });
  adapter.stat = jest.fn(async (value: string) => {
    const data = files.get(key(value));
    if (data === undefined) return folders.has(key(value)) ? { type: "folder", ctime: 1, mtime: 1, size: 0 } : null;
    return { type: "file", ctime: 1, mtime: 1, size: typeof data === "string" ? data.length : data.byteLength };
  });
  adapter.readBinary = jest.fn(async (value: string) => {
    const data = files.get(key(value));
    if (data === undefined || typeof data === "string") throw new Error(`ENOENT: ${value}`);
    return data;
  });
  return files;
}

/** Obsidian delivers workspace events and opens views in leaves; the base mock only records calls. */
function installWorkspace(app: any, views: () => Map<string, (leaf: unknown) => any>): any[] {
  const leaves: any[] = [];
  const handlers = new Map<string, Set<(...args: unknown[]) => unknown>>();
  jest.mocked(app.workspace.on).mockImplementation((name: string, callback: (...args: unknown[]) => unknown) => {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name)!.add(callback);
    return { name, callback };
  });
  jest.mocked(app.workspace.offref).mockImplementation((ref: { name: string; callback: () => unknown }) => {
    handlers.get(ref?.name)?.delete(ref?.callback);
  });
  jest.mocked(app.workspace.trigger).mockImplementation((name: string, ...args: unknown[]) => {
    for (const callback of [...(handlers.get(name) ?? [])]) callback(...args);
  });
  jest.mocked(app.workspace.getLeavesOfType).mockImplementation((type: string) =>
    leaves.filter((leaf) => leaf.view?.getViewType() === type));
  app.workspace.setActiveLeaf = jest.fn();
  app.workspace.revealLeaf = jest.fn(async () => undefined);
  app.workspace.getLeaf = jest.fn(() => {
    const leaf = new WorkspaceLeaf(app) as any;
    leaf.loadIfDeferred = jest.fn(async () => undefined);
    leaf.open = jest.fn(async (view: any) => {
      leaf.view = view;
      document.body.appendChild(view.containerEl);
      view.load();
      await view.onOpen();
    });
    leaf.setViewState = jest.fn(async (state: { type: string; state?: unknown }) => {
      if (leaf.view?.getViewType() !== state.type) await leaf.open(views().get(state.type)!(leaf));
      await leaf.view.setState(state.state ?? {});
    });
    leaves.push(leaf);
    return leaf;
  });
  return leaves;
}

describe.each(["desktop", "mobile"])("a new user's first run in the built bundle (%s)", (host) => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const originalPlatform = { ...Platform };
  const originalFetchTypes = { Response: window.Response, Headers: window.Headers };
  let plugin: any;
  let server: FakeSystemSculpt;
  let leaves: any[];
  let files: Map<string, string | ArrayBuffer>;
  let openedUrls: string[];

  beforeAll(() => {
    if (!existsSync(BUNDLE_PATH)) throw new Error("Run `npm run build` before this integration test.");
  });

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    Object.assign(window, hostFetch);
    Object.assign(Platform, {
      isDesktop: host === "desktop", isDesktopApp: host === "desktop",
      isMobile: host === "mobile", isMobileApp: host === "mobile",
    });
    openedUrls = [];
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      openedUrls.push(this.href);
    });
    server = new FakeSystemSculpt(manifest);
    installNetwork(server);
    const app = new App();
    files = installVault(app, manifest.id);
    leaves = installWorkspace(app, () => plugin._views);

    const bundle = require(BUNDLE_PATH);
    plugin = new (bundle.default ?? bundle)(app, manifest);
    // A fresh install: Obsidian has no saved data for the plugin yet.
    expect(await plugin.loadData()).toBeNull();
    const startupIdentity = captureStartupIdentity();
    plugin.load();
    await jest.advanceTimersByTimeAsync(1_500);
    expectProductionStartupIdentity(startupIdentity, manifest.version);
    // Nothing opens for a new install.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(document.querySelectorAll("[role='dialog']")).toHaveLength(0);
    expect(plugin.settings.licenseKey).toBe("");
    expect(plugin.settings.userEmail ?? "").toBe("");
  });

  afterEach(async () => {
    document.querySelectorAll<HTMLButtonElement>('button[data-testid="modal.close"]')
      .forEach((close) => close.click());
    for (const leaf of leaves) {
      await leaf.view?.onClose();
      leaf.view?.unload();
    }
    plugin?.unload();
    await jest.advanceTimersByTimeAsync(0);
    plugin = undefined;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Object.assign(window, originalFetchTypes);
    Object.assign(Platform, originalPlatform);
    document.body.replaceChildren();
    expect(server.unexpected).toEqual([]);
  });

  function control<T extends HTMLElement = HTMLButtonElement>(testId: string, root: ParentNode = document): T {
    const element = root.querySelector<T>(`[data-testid="${testId}"]`);
    expect(element).not.toBeNull();
    return element!;
  }

  function chat(): HTMLElement {
    expect(leaves).toHaveLength(1);
    return leaves[0].view.containerEl;
  }

  /** The conversation's messages as the user reads them, live turn included. */
  function turns(): string[] {
    const scroller = control("chat.scroller", chat());
    return Array.from(scroller.querySelectorAll(".systemsculpt-agent-turn")).flatMap((turn) => {
      if (turn.classList.contains("is-user")) return [`user: ${turn.querySelector(".systemsculpt-agent-turn-body")?.textContent}`];
      const text = Array.from(turn.querySelectorAll(".systemsculpt-agent-part.is-text"), (part) => part.textContent).join("");
      return text ? [`assistant: ${text}`] : [];
    });
  }

  function failure(): HTMLElement {
    const alert = chat().querySelector<HTMLElement>(".systemsculpt-agent-part.is-error[role='alert']");
    expect(alert).not.toBeNull();
    return alert!;
  }

  function composer(): HTMLTextAreaElement {
    return control<HTMLTextAreaElement>("chat.composer.input", chat());
  }

  async function type(text: string): Promise<void> {
    composer().value = text;
    composer().dispatchEvent(new Event("input", { bubbles: true }));
    await jest.advanceTimersByTimeAsync(0);
  }

  async function send(text: string): Promise<void> {
    await type(text);
    control("chat.composer.send", chat()).click();
    await jest.advanceTimersByTimeAsync(5_000);
  }

  /** The composer takes input and offers Send for it. */
  async function expectComposerUsable(): Promise<void> {
    const draft = composer().value;
    expect(composer().disabled).toBe(false);
    expect(composer().readOnly).toBe(false);
    await type("Can I still type here?");
    expect(control("chat.composer.send", chat()).disabled).toBe(false);
    await type(draft);
  }

  function expectAnswered(question: string): void {
    expect(turns()).toEqual([`user: ${question}`, `assistant: ${ANSWER}`]);
    expect(composer().value).toBe("");
  }

  /** The new user's way in: open chat, take its free-start offer, finish in the browser. */
  async function signUpFromChat(): Promise<void> {
    const ribbon = plugin._ribbons.filter((entry: { title: string }) => entry.title === "Open chat");
    expect(ribbon).toHaveLength(1);
    ribbon[0].callback();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(control("chat.empty.sign-in", chat()).textContent).toBe("Sign in");
    expect(control("chat.run.detail", chat()).textContent).toBe("Sign in");

    control("chat.empty.start-free", chat()).click();
    await jest.advanceTimersByTimeAsync(0);
    expect(document.querySelectorAll(".ss-upgrade-plan-modal")).toHaveLength(1);
    expect(openedUrls).toHaveLength(1);
    const signUp = new URL(openedUrls[0]);
    expect(`${signUp.origin}${signUp.pathname}`).toBe("https://systemsculpt.com/sign-up");
    const connect = new URL(signUp.searchParams.get("redirect_url")!, signUp.origin);
    expect(connect.pathname).toBe("/plugin/connect");

    await jest.advanceTimersByTimeAsync(3_500);
    const poll = server.requests.find(({ path }) => path === "/api/plugin/auth/poll");
    expect(createHash("sha256").update(poll!.body.verifier).digest("base64url"))
      .toBe(connect.searchParams.get("challenge"));
    expect(document.querySelector(".ss-upgrade-plan-modal")?.textContent).toContain("You're signed in");
    control("upgrade-plan.done").click();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(document.querySelectorAll("[role='dialog']")).toHaveLength(0);
    expect(await plugin.loadData()).toMatchObject({
      licenseKey: LICENSE_KEY,
      licenseValid: true,
      userEmail: "new-user@example.test",
    });
    // The open chat follows the new account without a reload.
    expect(chat().querySelector('[data-testid="chat.empty.start-free"]')).toBeNull();
    expect(control("chat.run.detail", chat()).textContent).toBe(`${STARTER_CREDITS} credits`);
  }

  it("receives a linked iPhone handoff, waits for Run, preserves the draft and reports a verified result note", async () => {
    await signUpFromChat();
    expect(plugin.settings.phoneHandoffsAutoRun).toBe(false);
    expect(server.paths().some(value => value.includes("/handoffs"))).toBe(false);
    await type("Keep my unrelated draft.");
    server.phoneHandoff = true;
    await plugin.getSettingsManager().updateSettings({ phoneCapturesLinked: true, phoneCapturesEnabled: false });
    await jest.advanceTimersByTimeAsync(1_000);
    const card = chat().querySelector<HTMLElement>(".systemsculpt-agent-phone-handoff")!;
    expect(card.textContent).toContain(server.handoff.instruction);
    expect(card.textContent).toContain("Three project notes.");
    expect(server.handoff.status).toBe("pending");
    expect(server.paths()).not.toContain("/api/plugin/agent/turn");
    expect([...files.keys()].some(value => value.startsWith("SystemSculpt/Handoffs/"))).toBe(false);
    const capability = server.requests.find(value => value.path === "/api/plugin/handoffs/capabilities");
    expect(capability?.body.agents).toEqual(["systemsculpt"]);
    // An unrelated capture confirmation may remain pending indefinitely. Focus
    // still polls handoffs instead of awaiting that batch's user decision.
    jest.spyOn(plugin.getPhoneCaptureInbox(), "maybeSync").mockReturnValue(new Promise(() => {}));
    const advertisements = server.paths().filter(value => value.endsWith("/handoffs/capabilities")).length;
    window.dispatchEvent(new Event("focus"));
    await jest.advanceTimersByTimeAsync(1_000);
    expect(server.paths().filter(value => value.endsWith("/handoffs/capabilities")).length).toBeGreaterThan(advertisements);
    control("chat.phone-handoff.run", card).click();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(leaves).toHaveLength(2);
    expect(control<HTMLTextAreaElement>("chat.composer.input", leaves[0].view.containerEl).value).toBe("Keep my unrelated draft.");
    const resultPath = `SystemSculpt/Handoffs/${server.handoff.id}.md`;
    expect(server.handoff).toMatchObject({ status: "completed", result_summary: ANSWER, vault_path: resultPath });
    expect(files.get(resultPath)).toContain(ANSWER);
    expect(files.get(resultPath)).toContain("handoff_state: completed");
    expect(files.get(resultPath)).not.toContain(LICENSE_KEY);
    expect(control("chat.phone-handoff.result", leaves[0].view.containerEl).textContent).toContain(resultPath);
  });

  it("installs, signs up from chat's offer, and streams the first answer", async () => {
    await signUpFromChat();
    server.holdAnswers = true;
    await type(QUESTION);
    control("chat.composer.send", chat()).click();
    await jest.advanceTimersByTimeAsync(1_000);
    // The first words arrive while the server is still answering.
    expect(turns()).toEqual([`user: ${QUESTION}`, "assistant: Your vault has"]);
    expect(control("chat.composer.stop", chat()).hidden).toBe(false);

    server.finishAnswer();
    await jest.advanceTimersByTimeAsync(1_000);
    expectAnswered(QUESTION);
    await expectComposerUsable();

    const bootstrap = server.requests.find(({ path }) => path === "/api/plugin/agent/bootstrap")!;
    expect(bootstrap.headers["x-license-key"]).toBe(LICENSE_KEY);
    expect(bootstrap.body.plugin_build_id)
      .toBe(`sha256:${createHash("sha256").update(readFileSync(BUNDLE_PATH)).digest("hex")}`);
    const turn = server.requests.find(({ path }) => path === "/api/plugin/agent/turn")!;
    expect(turn.via).toBe("fetch");
    expect(turn.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(turn.body).toMatchObject({
      kind: "submit",
      user_message: { role: "user", parts: [{ type: "text", text: QUESTION }] },
    });
    const saved = [...files].filter(([name]) => /^SystemSculpt\/Chats\/.+\.md$/.test(name));
    expect(saved).toHaveLength(1);
    expect(saved[0][1]).toEqual(expect.stringContaining(QUESTION));
    expect(saved[0][1]).toEqual(expect.stringContaining(ANSWER));
  });

  it("402 out of credits: offers plans, then answers once credits are added", async () => {
    await signUpFromChat();
    server.failNext("/api/plugin/agent/turn", {
      status: 402,
      json: { error: { code: "insufficient_credits", message: "Not enough credits." } },
    });
    server.credits = 0;
    await send(QUESTION);

    expect(failure().textContent).toContain("Out of credits");
    expect(control("chat.run.detail", chat()).textContent).toBe("Out of credits");
    control("chat.turn.see-plans", failure()).click();
    await jest.advanceTimersByTimeAsync(0);
    const plans = new URL(openedUrls[openedUrls.length - 1]);
    expect(`${plans.origin}${plans.pathname}`).toBe("https://systemsculpt.com/pricing");
    await expectComposerUsable();

    // After buying credits, the run line's credits view reads the new balance.
    server.credits = 10_000;
    control("chat.run.detail", chat()).click();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("10,000 credits");
    control("modal.close").click();
    await jest.advanceTimersByTimeAsync(500);
    expect(control("chat.run.detail", chat()).textContent).toBe("10,000 credits");
    await send("Try again");
    expect(turns().slice(-2)).toEqual(["user: Try again", `assistant: ${ANSWER}`]);
    expect(composer().value).toBe("");
  });

  it.each([
    ["503 from the service", () => server.failNext("/api/plugin/agent/bootstrap", {
      status: 503,
      json: { error: {
        code: "agent_unavailable",
        message: "SystemSculpt Agent is temporarily unavailable.",
        incident_id: "incident_0123456789abcdef0123456789abcdef",
      } },
    })],
    ["offline", () => { server.online = false; }],
  ])("%s: keeps the message and answers on Retry", async (_name, fail) => {
    await signUpFromChat();
    fail();
    await send(QUESTION);

    expect(failure().textContent).toContain("Could not finish");
    expect(turns()).toEqual([]);
    expect(composer().value).toBe(QUESTION);
    expect(server.paths()).not.toContain("/api/plugin/agent/turn");
    await expectComposerUsable();

    server.online = true;
    control("chat.turn.retry-failed", failure()).click();
    await jest.advanceTimersByTimeAsync(5_000);
    expectAnswered(QUESTION);
    expect(chat().querySelector(".systemsculpt-agent-part.is-error")).toBeNull();
  });

  function rejectLicense(): void {
    server.failNext("/api/plugin/agent/bootstrap", {
      status: 403,
      json: {
        contract_version: "admission-v1",
        code: "license_rejected",
        message: "License key was rejected.",
        request_id: "req_license_rejected",
        reason: "revoked",
      },
    });
  }

  it("403 license_rejected: shows the failure and keeps the message", async () => {
    await signUpFromChat();
    rejectLicense();
    await send(QUESTION);

    expect(failure().isConnected).toBe(true);
    expect(turns()).toEqual([]);
    expect(composer().value).toBe(QUESTION);
    expect(server.paths()).not.toContain("/api/plugin/agent/turn");
    await expectComposerUsable();
  });

  describe.each([false, true])("automatic plan prompt suppression: %s", (suppressLicenseUpgradePrompt) => {
    it("403 license_rejected: offers the plan step, and syncing the license answers", async () => {
      await signUpFromChat();
      await plugin.getSettingsManager().updateSettings({ suppressLicenseUpgradePrompt });
      const browserOpens = openedUrls.length;
      rejectLicense();
      await send(QUESTION);

      expect(document.querySelectorAll(".ss-upgrade-plan-modal")).toHaveLength(0);
      expect(openedUrls).toHaveLength(browserOpens);
      control("chat.turn.see-plans", failure()).click();
      await jest.advanceTimersByTimeAsync(0);
      expect(document.querySelectorAll(".ss-upgrade-plan-modal")).toHaveLength(1);
      expect(openedUrls).toHaveLength(browserOpens);
      control("upgrade-plan.sync").click();
      await jest.advanceTimersByTimeAsync(3_500);
      expect(openedUrls).toHaveLength(browserOpens + 1);
      expect(document.querySelector(".ss-upgrade-plan-modal")?.textContent).toContain("You're signed in");
      control("upgrade-plan.done").click();
      await jest.advanceTimersByTimeAsync(1_000);
      await send(QUESTION);
      expectAnswered(QUESTION);
      expect(plugin.settings.suppressLicenseUpgradePrompt).toBe(suppressLicenseUpgradePrompt);
    });
  });

  it("402 out of credits: a second send keeps its typed message", async () => {
    await signUpFromChat();
    server.failNext("/api/plugin/agent/turn", {
      status: 402,
      json: { error: { code: "insufficient_credits", message: "Not enough credits." } },
    });
    server.credits = 0;
    await send(QUESTION);
    const turnRequests = () => server.requests.filter(({ path }) => path === "/api/plugin/agent/turn");
    const attempts = turnRequests().length;
    await send("Second try");

    expect(control("chat.banner.see-plans", chat()).isConnected).toBe(true);
    expect(composer().value).toBe("Second try");
    expect(turnRequests()).toHaveLength(attempts);
    await expectComposerUsable();

    server.credits = 10_000;
    control("chat.run.detail", chat()).click();
    await jest.advanceTimersByTimeAsync(1_000);
    control("modal.close").click();
    await jest.advanceTimersByTimeAsync(500);
    control("chat.composer.send", chat()).click();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(turns().slice(-2)).toEqual(["user: Second try", `assistant: ${ANSWER}`]);
    expect(composer().value).toBe("");
  });
});
