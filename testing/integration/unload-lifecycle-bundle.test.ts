/** @jest-environment jsdom */

/**
 * Built-bundle unload contract. Obsidian unloads a plugin in place when the
 * user updates it or toggles it off and on, then evaluates main.js again
 * against the same App, window and document. Anything onload starts that
 * unload misses keeps the old bundle and its state alive until Obsidian
 * restarts, once per update.
 *
 * This suite evaluates the exact artifact the way Obsidian does, opens the
 * main surfaces, closes them, unloads, and requires every host-owned
 * registration to return to its count before load: window and document
 * listeners, pending timeouts and intervals, observers watching the live
 * document, workspace/vault/metadataCache event refs, and nodes left in the
 * document. Reloading must not grow any of them, and the first instance and
 * its bundle must become collectable.
 *
 * Run `npm run build` first (npm run test:integration does this for you).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { App, Modal, Platform, WorkspaceLeaf, requestUrl } from "obsidian";

const BUNDLE_PATH = path.resolve(__dirname, "..", "..", "main.js");
const MANIFEST = JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "manifest.json"), "utf8"));
const CHAT_VIEW_TYPE = "systemsculpt-chat-view";
const EMBEDDINGS_VIEW_TYPE = "systemsculpt-embeddings-view";
/** Host time for every deferred startup phase, and for unload to drain. */
const SETTLE_MS = 120_000;

type Registration = Readonly<{ label: string; source: string }>;
type Snapshot = Record<string, Registration[]>;

/** The first frames past this suite's own wrappers, so a leak names its source. */
function callerFrames(): string {
  return (new Error().stack ?? "")
    .split("\n")
    .slice(1)
    .filter((line) => line.includes(" at ") && !line.includes("unload-lifecycle-bundle.test"))
    .slice(0, 4)
    .map((line) => line.trim())
    .join(" | ");
}

/** Wraps add/removeEventListener on one target and keeps the live set. */
function trackListeners(target: EventTarget, name: string) {
  const nativeAdd = target.addEventListener;
  const nativeRemove = target.removeEventListener;
  type Entry = Registration & {
    type: string;
    listener: EventListenerOrEventListenerObject;
    capture: boolean;
    afterOnce?: () => void;
  };
  const live: Entry[] = [];
  const captureOf = (options?: boolean | EventListenerOptions) =>
    typeof options === "boolean" ? options : Boolean(options?.capture);
  const find = (type: string, listener: unknown, capture: boolean) =>
    live.find((entry) => entry.type === type && entry.listener === listener && entry.capture === capture);
  const drop = (entry: Entry) => {
    const index = live.indexOf(entry);
    if (index >= 0) live.splice(index, 1);
    if (entry.afterOnce) nativeRemove.call(target, entry.type, entry.afterOnce, entry.capture);
  };

  target.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    nativeAdd.call(this, type, listener, options);
    const capture = captureOf(options);
    const signal = typeof options === "object" ? options.signal : undefined;
    if (!listener || signal?.aborted || find(type, listener, capture)) return;
    const entry: Entry = { type, listener, capture, label: `${name} ${type}`, source: callerFrames() };
    live.push(entry);
    if (typeof options === "object" && options.once) {
      // Added after the listener, so it runs right after the listener's one call.
      entry.afterOnce = () => drop(entry);
      nativeAdd.call(this, type, entry.afterOnce, { capture, once: true });
    }
    signal?.addEventListener("abort", () => drop(entry), { once: true });
  };
  target.removeEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    nativeRemove.call(this, type, listener, options);
    const entry = find(type, listener, captureOf(options));
    if (entry) drop(entry);
  };
  return {
    live: (): Registration[] => [...live],
    restore() {
      Reflect.deleteProperty(target, "addEventListener");
      Reflect.deleteProperty(target, "removeEventListener");
    },
  };
}

/** Records pending timeouts and intervals on top of Jest's fake clock. */
function trackTimers() {
  const g = globalThis as any;
  const fake = {
    setTimeout: g.setTimeout,
    clearTimeout: g.clearTimeout,
    setInterval: g.setInterval,
    clearInterval: g.clearInterval,
  };
  const timeouts = new Map<unknown, Registration>();
  const intervals = new Map<unknown, Registration>();
  let restored = false;
  g.setTimeout = (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const id = fake.setTimeout((...callArgs: unknown[]) => {
      timeouts.delete(id);
      callback(...callArgs);
    }, delay, ...args);
    timeouts.set(id, { label: `timeout ${delay ?? 0} ms`, source: callerFrames() });
    return id;
  };
  g.clearTimeout = (id: unknown) => {
    timeouts.delete(id);
    fake.clearTimeout(id);
  };
  g.setInterval = (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const id = fake.setInterval(callback, delay, ...args);
    intervals.set(id, { label: `interval ${delay ?? 0} ms`, source: callerFrames() });
    return id;
  };
  g.clearInterval = (id: unknown) => {
    intervals.delete(id);
    fake.clearInterval(id);
  };
  return {
    timeouts: (): Registration[] => [...timeouts.values()],
    intervals: (): Registration[] => [...intervals.values()],
    /** Jest uninstalls only its own fakes, so put them back first, once. */
    restore() {
      if (restored) return;
      restored = true;
      Object.assign(g, fake);
    },
  };
}

/**
 * An observer keeps its callback alive only while it watches the live
 * document: one whose targets were all detached is collected with them, so
 * this record holds observers and targets weakly.
 */
function trackObservers() {
  const g = globalThis as any;
  const names = ["MutationObserver", "ResizeObserver", "IntersectionObserver"] as const;
  const originals = Object.fromEntries(names.map((name) => [name, g[name]]));
  type Watch = { registration: Registration; targets: Set<WeakRef<Node>> };
  const watches = new WeakMap<object, Watch>();
  const observers = new Set<WeakRef<object>>();
  const tracked = (Base: any, name: string) => class extends Base {
    observe(target: Node, options?: unknown) {
      super.observe?.(target, options);
      let watch = watches.get(this);
      if (!watch) {
        watch = { registration: { label: name, source: callerFrames() }, targets: new Set() };
        watches.set(this, watch);
        observers.add(new WeakRef(this));
      }
      watch.targets.add(new WeakRef(target));
    }
    unobserve(target: Node) {
      super.unobserve?.(target);
      const targets = watches.get(this)?.targets ?? new Set<WeakRef<Node>>();
      for (const ref of targets) if (ref.deref() === target) targets.delete(ref);
    }
    disconnect() {
      super.disconnect?.();
      watches.get(this)?.targets.clear();
    }
  };
  // jsdom lacks the Resize and Intersection observers Electron has, so stub
  // them and the plugin takes its real desktop path.
  for (const name of names) g[name] = tracked(originals[name] ?? class {}, name);
  return {
    live: (): Registration[] => [...observers].flatMap((ref) => {
      const observer = ref.deref();
      const watch = observer && watches.get(observer);
      if (!watch) {
        observers.delete(ref);
        return [];
      }
      return [...watch.targets].some((target) => target.deref()?.isConnected) ? [watch.registration] : [];
    }),
    restore() {
      for (const name of names) {
        if (originals[name]) g[name] = originals[name];
        else Reflect.deleteProperty(g, name);
      }
    },
  };
}

/** Obsidian's Events: on() returns a ref that offref() or a Component unload releases. */
function trackEvents(target: any, name: string) {
  type Ref = Registration & { e: unknown; name: string; fn: (...args: unknown[]) => unknown; ctx?: unknown; unload(): void };
  const live = new Set<Ref>();
  target.on = (event: string, fn: Ref["fn"], ctx?: unknown) => {
    const ref: Ref = {
      e: target, name: event, fn, ctx, label: `${name} ${event}`, source: callerFrames(),
      unload: () => { live.delete(ref); },
    };
    live.add(ref);
    return ref;
  };
  target.offref = (ref: Ref) => { live.delete(ref); };
  target.off = (event: string, fn: unknown) => {
    for (const ref of live) if (ref.name === event && ref.fn === fn) live.delete(ref);
  };
  target.trigger = (event: string, ...args: unknown[]) => {
    for (const ref of [...live]) if (ref.name === event) ref.fn.apply(ref.ctx, args);
  };
  target.tryTrigger = target.trigger;
  return { live: (): Registration[] => [...live] };
}

/** One Obsidian App, window and document that outlive every plugin instance. */
function createHost() {
  const app = new App() as any;
  const leaves: any[] = [];
  let views = new Map<string, (leaf: unknown) => any>();

  const createLeaf = () => {
    const leaf = new WorkspaceLeaf(app) as any;
    leaf.open = async (view: any) => {
      await leaf.closeView();
      leaf.view = view;
      document.body.appendChild(view.containerEl);
      view.load();
      await view.onOpen();
    };
    leaf.closeView = async () => {
      const view = leaf.view;
      if (!view) return;
      leaf.view = null;
      view.unload();
      await view.onClose();
      view.containerEl.remove();
    };
    leaf.setViewState = async (state: any) => {
      leaf._viewState = state;
      if (leaf.view?.getViewType() !== state.type) {
        const create = views.get(state.type);
        if (!create) throw new Error(`No view registered for ${state.type}`);
        await leaf.open(create(leaf));
      }
      await leaf.view.setState?.(state.state ?? {}, { history: false });
    };
    leaf.loadIfDeferred = async () => undefined;
    leaf.detach = () => {
      const index = leaves.indexOf(leaf);
      if (index >= 0) leaves.splice(index, 1);
      return leaf.closeView();
    };
    leaves.push(leaf);
    return leaf;
  };

  Object.assign(app.workspace, {
    layoutReady: true,
    getLeaf: () => createLeaf(),
    getRightLeaf: () => createLeaf(),
    getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.view?.getViewType() === type),
    iterateAllLeaves: (callback: (leaf: unknown) => void) => [...leaves].forEach(callback),
    detachLeavesOfType: (type: string) => {
      for (const leaf of leaves.filter((candidate) => candidate.view?.getViewType() === type)) void leaf.detach();
    },
    revealLeaf: async () => undefined,
    setActiveLeaf: () => undefined,
    updateOptions: () => undefined,
  });
  const events = {
    workspace: trackEvents(app.workspace, "workspace"),
    vault: trackEvents(app.vault, "vault"),
    metadataCache: trackEvents(app.metadataCache, "metadataCache"),
  };

  return {
    app,
    leaves,
    events,
    /** Obsidian registers a plugin's views on load and unregisters them on unload. */
    useViewsOf(plugin: any) { views = plugin?._views ?? new Map(); },
  };
}

/**
 * Obsidian's module loader. The desktop has no agent CLI installed and no
 * browser to open; the phone loads no Node or Electron module at all.
 */
function hostModules(host: "desktop" | "mobile", refused: string[]) {
  const missing = (target: unknown) =>
    Object.assign(new Error(`ENOENT: no such file or directory, '${String(target)}'`), { code: "ENOENT" });
  const fs = new Proxy({}, {
    // Awaiting the module must not treat it as a thenable.
    get: (_target, key) => key === "then" || typeof key === "symbol"
      ? undefined
      : async (target: unknown) => { throw missing(target); },
  });
  const os = { ...require("node:os"), homedir: () => "/unload-suite/home", tmpdir: () => "/unload-suite/tmp" };
  const electron = {
    shell: { openExternal: async () => undefined, openPath: async () => "", showItemInFolder: () => undefined },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  };
  return (specifier: string) => {
    switch (host === "desktop" ? specifier.replace(/^node:/, "") : null) {
      case "fs/promises": return fs;
      case "os": return os;
      case "path": return require("node:path");
      case "electron": return electron;
      default:
        refused.push(specifier);
        throw new Error(`${specifier} is unavailable in the unload suite`);
    }
  };
}

/** Evaluates main.js afresh, as Obsidian does on each enable or update. */
function evaluateBundle(): any {
  const module = { exports: {} as any };
  const source = `${readFileSync(BUNDLE_PATH, "utf8")}\n//# sourceURL=plugin:${MANIFEST.id}\n`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("require", "module", "exports", source)(require, module, module.exports);
  return module.exports.default ?? module.exports;
}

/**
 * jsdom's selector engines keep each selector's last results and context,
 * which can be detached plugin nodes; Chromium keeps no such cache. Clear
 * them before asking whether anything else still reaches the old instance.
 */
function clearSelectorCaches(): void {
  const implSymbol = Object.getOwnPropertySymbols(document).find((symbol) => symbol.description === "impl");
  const impl = implSymbol ? (document as any)[implSymbol] : null;
  const engines = [impl?._nwsapi, impl?._nwsapiDontThrow].filter(Boolean);
  if (engines.length === 0) throw new Error("jsdom's selector engines were not found");
  for (const engine of engines) {
    // The engine exports its first cache objects and swaps its own on reset.
    for (const cache of [engine.selectResolvers, engine.matchResolvers]) {
      for (const key of Object.keys(cache)) delete cache[key];
    }
    engine.configure({}, true);
    engine.select("html", document);
  }
}

/** Jest's own leak detector exposes gc the same way. */
function exposeGc(): (() => void) | null {
  const g = globalThis as any;
  if (typeof g.gc === "function") return g.gc;
  try {
    require("node:v8").setFlagsFromString("--expose-gc");
    return require("node:vm").runInNewContext("gc");
  } catch {
    return null;
  }
}

function jsonResponse(status: number, payload: unknown) {
  return {
    status,
    headers: { "content-type": "application/json" },
    text: JSON.stringify(payload),
    json: payload,
    arrayBuffer: new ArrayBuffer(0),
  };
}

const HOSTS = {
  desktop: { isDesktop: true, isDesktopApp: true, isMobile: false, isMobileApp: false, isPhone: false, isAndroidApp: false },
  mobile: { isDesktop: false, isDesktopApp: false, isMobile: true, isMobileApp: true, isPhone: true, isAndroidApp: true },
} as const;

/** Each modal command a person can open from the palette or a ribbon. */
const MODAL_COMMANDS = [
  "open-systemsculpt-search",
  "open-systemsculpt-history",
  "open-systemsculpt-janitor",
  "open-credits-balance",
];

describe.each(["desktop", "mobile"] as const)("plugin unload in the built bundle (%s)", (hostKind) => {
  const originalPlatform = { ...Platform };
  const originalRequire = Object.getOwnPropertyDescriptor(window, "require");
  let windowListeners: ReturnType<typeof trackListeners>;
  let documentListeners: ReturnType<typeof trackListeners>;
  let timers: ReturnType<typeof trackTimers>;
  let observers: ReturnType<typeof trackObservers>;
  let host: ReturnType<typeof createHost>;
  let unexpectedRequests: string[];
  let refusedModules: string[];

  function snapshot(): Snapshot {
    return {
      windowListeners: windowListeners.live(),
      documentListeners: documentListeners.live(),
      timeouts: timers.timeouts(),
      intervals: timers.intervals(),
      observers: observers.live(),
      workspaceRefs: host.events.workspace.live(),
      vaultRefs: host.events.vault.live(),
      metadataCacheRefs: host.events.metadataCache.live(),
      documentNodes: [...Array.from(document.head.children), ...Array.from(document.body.children)]
        .map((node) => ({ label: `<${node.tagName.toLowerCase()} class="${node.className}">`, source: "" })),
    };
  }

  /** Every count that moved from the baseline, with what was added and where. */
  function changesSince(baseline: Snapshot): Record<string, string[]> {
    const changes: Record<string, string[]> = {};
    for (const [key, entries] of Object.entries(snapshot())) {
      if (entries.length === baseline[key].length) continue;
      changes[key] = entries
        .filter((entry) => !baseline[key].includes(entry))
        .map((entry) => (entry.source ? `${entry.label} @ ${entry.source}` : entry.label));
    }
    return changes;
  }

  /** Advances the fake clock until the work settles, as Obsidian's real clock would. */
  async function settle<T>(work: Promise<T> | T, step = 1_000): Promise<T> {
    let done = false;
    const result = Promise.resolve(work).finally(() => { done = true; });
    for (let elapsed = 0; !done && elapsed < SETTLE_MS; elapsed += step) {
      await jest.advanceTimersByTimeAsync(step);
    }
    if (!done) throw new Error(`Work did not settle within ${SETTLE_MS} ms of host time`);
    return result;
  }

  function command(plugin: any, id: string) {
    const found = plugin._commands.find((candidate: { id: string }) => candidate.id === id);
    if (!found) throw new Error(`Command ${id} is not registered`);
    return found;
  }

  async function load(): Promise<{ plugin: any; PluginClass: any }> {
    const PluginClass = evaluateBundle();
    const plugin = new PluginClass(host.app, MANIFEST);
    host.useViewsOf(plugin);
    plugin.load();
    await jest.advanceTimersByTimeAsync(SETTLE_MS);
    await settle(plugin.criticalInitializationPromise);
    await settle(plugin.deferredInitializationPromise);
    return { plugin, PluginClass };
  }

  async function unload(plugin: any): Promise<void> {
    plugin.unload();
    host.useViewsOf(null);
    await settle(plugin.unloadPromise);
    await jest.advanceTimersByTimeAsync(SETTLE_MS);
  }

  /**
   * A signed-in user opens Chat, Similar Notes, each modal and every settings
   * tab, starts a browser sign-in and leaves it pending, then closes
   * everything.
   */
  async function openAndCloseSurfaces(plugin: any): Promise<void> {
    plugin.settings.licenseKey = "unload-suite-license";
    plugin.settings.licenseValid = true;
    // Hosted execution, so Chat never starts a native agent turn.
    plugin.settings.textExecutionBackend = "systemsculpt";
    plugin.settings.textExecutionBackendExplicit = true;

    await settle(command(plugin, "open-systemsculpt-chat").callback());
    expect(host.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)).toHaveLength(1);
    await settle(command(plugin, "open-embeddings-view").callback());
    expect(host.app.workspace.getLeavesOfType(EMBEDDINGS_VIEW_TYPE)).toHaveLength(1);

    const opened: any[] = [];
    const nativeOpen = Modal.prototype.open;
    const open = jest.spyOn(Modal.prototype, "open").mockImplementation(function (this: any) {
      opened.push(this);
      return nativeOpen.call(this);
    });
    for (const id of MODAL_COMMANDS) {
      await settle(command(plugin, id).callback());
      expect({ id, opened: opened.length }).toEqual({ id, opened: 1 });
      opened.pop().close();
      await settle(undefined);
    }
    open.mockRestore();

    const settingsTab = plugin.settingsTab;
    document.body.appendChild(settingsTab.containerEl);
    settingsTab.display();
    const tabIds = [...settingsTab.containerEl.querySelectorAll("button[data-tab]")]
      .map((button) => (button as HTMLElement).dataset.tab);
    expect(tabIds.length).toBeGreaterThan(1);
    for (const tabId of tabIds) {
      settingsTab.containerEl.querySelector(`button[data-tab="${tabId}"]`).click();
      await settle(undefined);
      expect(settingsTab.containerEl.querySelector(`.systemsculpt-tab-content[data-tab="${tabId}"]`).childElementCount)
        .toBeGreaterThan(0);
    }
    await settle(plugin.getAccountConnectService().begin("sign-in"));
    expect(plugin.getAccountConnectService().hasPendingRequest()).toBe(true);
    // Closing settings leaves the sign-in polling in the background.
    settingsTab.hide();
    settingsTab.containerEl.empty();
    settingsTab.containerEl.remove();
    await settle(undefined);

    for (const leaf of [...host.leaves]) await settle(leaf.detach());
  }

  /** Its own frame, so no register of the test's frame still holds the instance. */
  async function firstCycle(): Promise<{ instance: WeakRef<object>; bundle: WeakRef<object> }> {
    const { plugin, PluginClass } = await load();
    await openAndCloseSurfaces(plugin);
    await unload(plugin);
    return { instance: new WeakRef(plugin), bundle: new WeakRef(PluginClass) };
  }

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    Object.assign(Platform, HOSTS[hostKind]);
    if (hostKind === "mobile") document.body.classList.add("is-mobile", "is-phone");
    // jsdom's two selector engines add their own document listeners on first use.
    document.querySelector("*");
    window.getComputedStyle(document.documentElement);
    timers = trackTimers();
    windowListeners = trackListeners(window, "window");
    documentListeners = trackListeners(document, "document");
    observers = trackObservers();
    host = createHost();
    unexpectedRequests = [];
    refusedModules = [];
    for (const method of ["debug", "info", "log", "warn", "error"] as const) {
      jest.spyOn(console, method).mockImplementation(() => undefined);
    }
    jest.spyOn(window, "open").mockImplementation(() => null);
    Object.defineProperty(window, "require", {
      configurable: true,
      writable: true,
      value: hostModules(hostKind, refusedModules),
    });

    const route = (url: string): { status: number; payload: unknown } | null => {
      if (url.endsWith("/releases/latest")) {
        return {
          status: 200,
          payload: {
            contract_version: "plugin-release-v1", plugin_id: MANIFEST.id,
            latest_version: MANIFEST.version,
            release_url: `https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/tag/${MANIFEST.version}`,
            published_at: "2026-10-24T00:00:00.000Z",
          },
        };
      }
      if (url.endsWith("/credits/balance")) {
        return {
          status: 200,
          payload: {
            included_remaining: 1000, add_on_remaining: 0, total_remaining: 1000,
            included_per_month: 1000, usage_class: "customer",
            cycle_anchor_at: "2026-10-01T00:00:00.000Z",
            cycle_started_at: "2026-10-01T00:00:00.000Z",
            cycle_ends_at: "2026-11-01T00:00:00.000Z", turn_in_flight_until: null,
          },
        };
      }
      if (url.endsWith("/auth/poll")) return { status: 202, payload: { status: "pending" } };
      unexpectedRequests.push(url);
      return null;
    };
    jest.mocked(requestUrl).mockImplementation((async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      const answer = route(url);
      if (!answer) throw new Error(`Unexpected host request: ${url}`);
      return jsonResponse(answer.status, answer.payload);
    }) as any);
    jest.spyOn(window, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      const answer = route(url);
      if (!answer) throw new Error(`Unexpected fetch: ${url}`);
      return new Response(JSON.stringify(answer.payload), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    timers.restore();
    jest.useRealTimers();
    jest.restoreAllMocks();
    windowListeners.restore();
    documentListeners.restore();
    observers.restore();
    if (originalRequire) Object.defineProperty(window, "require", originalRequire);
    else Reflect.deleteProperty(window, "require");
    Object.assign(Platform, originalPlatform);
    document.head.replaceChildren();
    document.body.replaceChildren();
    document.body.className = "";
  });

  it("returns every host registration to its count before load after the main surfaces open and close", async () => {
    const baseline = snapshot();
    const { plugin } = await load();
    // The probes see what a running plugin holds, so a clean unload is not vacuous.
    expect(Object.keys(changesSince(baseline)).length).toBeGreaterThan(1);

    await openAndCloseSurfaces(plugin);
    await unload(plugin);

    expect(changesSince(baseline)).toEqual({});
    expect({ unexpectedRequests, refusedModules }).toEqual({ unexpectedRequests: [], refusedModules: [] });
  });

  it("reloads three times without growth and releases the first instance and its bundle", async () => {
    const gc = exposeGc();
    if (!gc) throw new Error("gc could not be exposed");
    const baseline = snapshot();

    const first = await firstCycle();
    expect({ cycle: 0, changes: changesSince(baseline) }).toEqual({ cycle: 0, changes: {} });
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await unload((await load()).plugin);
      expect({ cycle, changes: changesSince(baseline) }).toEqual({ cycle, changes: {} });
    }
    expect({ unexpectedRequests, refusedModules }).toEqual({ unexpectedRequests: [], refusedModules: [] });

    // Mock call records would otherwise hold arguments the bundle passed.
    jest.clearAllMocks();
    clearSelectorCaches();
    jest.clearAllTimers();
    timers.restore();
    jest.useRealTimers();
    const released = () => ({ instance: first.instance.deref() === undefined, bundle: first.bundle.deref() === undefined });
    for (let attempt = 0; attempt < 10 && Object.values(released()).includes(false); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gc();
    }
    expect(released()).toEqual({ instance: true, bundle: true });
  });
});
