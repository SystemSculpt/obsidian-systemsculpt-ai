/** @jest-environment jsdom */
/**
 * The compiled plugin's one-time check for Studio history from before 6.10
 * (#354): a normal startup in such a vault shows one notice with the space it
 * frees, and Delete removes only the folders of projects that open now.
 */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const DEFAULT_ARTIFACT_ROOT = path.resolve(__dirname, "..", "..");
const ARTIFACT_ROOT = process.env.SYSTEMSCULPT_PLUGIN_ARTIFACT_ROOT?.trim()
  ? path.resolve(process.env.SYSTEMSCULPT_PLUGIN_ARTIFACT_ROOT)
  : DEFAULT_ARTIFACT_ROOT;
const BUNDLE_PATH = path.join(ARTIFACT_ROOT, "main.js");
const MANIFEST_PATH = path.join(ARTIFACT_ROOT, "manifest.json");
const LEGACY = ".systemsculpt/studio/projects";
const CHECK_PATH = ".systemsculpt/studio/legacy-generations-check.json";

type Bytes = string | Uint8Array;
const size = (value: Bytes) => typeof value === "string" ? new TextEncoder().encode(value).length : value.length;

function memoryAdapter(files: Map<string, Bytes>) {
  const folders = new Set<string>();
  const isFolder = (p: string) => folders.has(p) || [...files.keys()].some((file) => file.startsWith(`${p}/`));
  const missing = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  const text = (p: string) => { const value = files.get(p); if (value === undefined) throw missing(p); return typeof value === "string" ? value : new TextDecoder().decode(value); };
  return {
    exists: async (p: string) => files.has(p) || isFolder(p),
    mkdir: async (p: string) => { folders.add(p); },
    read: async (p: string) => text(p),
    write: async (p: string, data: string) => { files.set(p, data); },
    readBinary: async (p: string) => new TextEncoder().encode(text(p)).buffer,
    writeBinary: async (p: string, data: ArrayBuffer) => { files.set(p, new Uint8Array(data)); },
    process: async (p: string, update: (raw: string) => string) => { const next = update(files.has(p) ? text(p) : ""); files.set(p, next); return next; },
    list: async (p: string) => {
      const children = new Set<string>(), result = { files: [] as string[], folders: [] as string[] };
      for (const file of files.keys()) {
        if (!file.startsWith(`${p}/`)) continue;
        const [name, ...rest] = file.slice(p.length + 1).split("/");
        if (children.has(name)) continue;
        children.add(name);
        (rest.length ? result.folders : result.files).push(`${p}/${name}`);
      }
      return result;
    },
    stat: async (p: string) => files.has(p) ? { type: "file", ctime: 0, mtime: 0, size: size(files.get(p)!) } : isFolder(p) ? { type: "folder", ctime: 0, mtime: 0, size: 0 } : null,
    remove: async (p: string) => { files.delete(p); },
    rmdir: async (p: string) => { for (const file of [...files.keys()]) if (file.startsWith(`${p}/`)) files.delete(file); folders.delete(p); },
    rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
    trashLocal: async () => undefined,
    getFullPath: (p: string) => p,
  };
}

/** Each generation held its own full copy of the project's media. */
function addGenerations(files: Map<string, Bytes>, projectId: string, count: number): void {
  const media = new Uint8Array(1_000_000).fill(5);
  for (let revision = 0; revision < count; revision++) {
    const root = `${LEGACY}/${projectId}/generations/${revision}-${revision.toString(16).padStart(64, "0")}`;
    files.set(`${root}/commit.json`, JSON.stringify({ projectId, revision, schemaVersion: 1 }));
    files.set(`${root}/files/project.systemsculpt`, JSON.stringify({ schema: "studio.project.v2", id: projectId, canvas: { nodes: [] } }));
    files.set(`${root}/files/support/assets/sha256/05/${"5".repeat(64)}.png`, media);
  }
}

async function until<T>(read: () => T | null | undefined | false, label: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

describe("built bundle legacy Studio history check", () => {
  const idleWindow = window as Window & { requestIdleCallback?: (callback: () => void) => number };

  beforeAll(() => {
    if (!existsSync(BUNDLE_PATH)) throw new Error("Built bundle not found; run `npm run build` first.");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete idleWindow.requestIdleCallback;
    document.body.innerHTML = "";
  });

  /** Start the compiled plugin in a vault from before 6.10, through layout-ready. */
  async function startInLegacyVault() {
    idleWindow.requestIdleCallback = (callback) => window.setTimeout(callback, 0);
    const files = new Map<string, Bytes>([
      ["SystemSculpt/Studio/Alpha.systemsculpt", JSON.stringify({ schema: "studio.project.v2", id: "proj_alpha", name: "Alpha", canvas: { nodes: [] } }, null, 2)],
      ["SystemSculpt/Studio/Broken.systemsculpt", JSON.stringify({ schema: "studio.project.v2", id: "proj_broken", canvas: { nodes: "not a list" } })],
    ]);
    addGenerations(files, "proj_alpha", 4);
    addGenerations(files, "proj_broken", 2);
    addGenerations(files, "proj_gone", 2);
    const before = new Map(files);
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    const notices: HTMLElement[] = [];
    const layoutReady: Array<() => void | Promise<void>> = [];
    // One module registry: the cleanup module loads lazily, after jest.isolateModules would have returned.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const host = require("obsidian");
    // Obsidian's notice: the message sits in noticeEl, and clicking the notice hides it.
    host.Notice = class {
      noticeEl: HTMLElement;
      constructor(message: string | DocumentFragment) {
        this.noticeEl = document.body.createDiv({ cls: "notice" });
        if (typeof message === "string") this.noticeEl.setText(message);
        else this.noticeEl.appendChild(message);
        this.noticeEl.addEventListener("click", () => this.hide());
        notices.push(this.noticeEl);
      }
      hide() { this.noticeEl.remove(); }
      setMessage() { return this; }
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bundleModule = require(BUNDLE_PATH);
    const PluginClass = bundleModule?.default ?? bundleModule;
    const app = new host.App();
    app.vault.adapter = memoryAdapter(files);
    app.vault.getFiles = () => [...files.keys()].filter((p) => !p.startsWith(".")).map((p) => ({ path: p, extension: p.split(".").pop() }));
    app.workspace.offref = jest.fn();
    app.workspace.onLayoutReady = jest.fn((callback: () => void | Promise<void>) => {
      layoutReady.push(callback);
      return { unload: jest.fn() };
    });
    const plugin = new PluginClass(app, manifest);

    // The startup identity line is expected; any other console output fails under strict console.
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    plugin.load();
    await until(() => layoutReady.length > 0 && plugin.criticalInitializationPromise, "layout-ready registration");
    await plugin.criticalInitializationPromise;
    await plugin.deferredInitializationPromise;
    for (const callback of layoutReady) await callback();
    const confirm = await until(() => document.querySelector<HTMLButtonElement>('[data-testid="notice.confirm"]'), "the cleanup notice");
    return { files, before, notices, plugin, confirm };
  }

  it("asks once at startup and deletes only the folders of projects that open", async () => {
    const { files, before, notices, plugin, confirm } = await startInLegacyVault();
    const offer = confirm.closest(".notice")!;
    // Four generations of Alpha, about 1 MB each; the failing project and the orphan are not counted.
    expect(offer.querySelector(".systemsculpt-notice-message")?.textContent).toBe(
      "SystemSculpt Studio no longer uses the project history saved before version 6.10. Delete it to free 4 MB? Your projects stay as they are.",
    );
    expect(offer.querySelector('[data-testid="notice.cancel"]')?.textContent).toBe("Keep");
    expect(files.has(CHECK_PATH)).toBe(false);

    confirm.click();

    await until(() => files.has(CHECK_PATH), "the recorded check");
    expect(JSON.parse(files.get(CHECK_PATH) as string)).toMatchObject({ outcome: "deleted" });
    expect([...files.keys()].filter((p) => p.startsWith(`${LEGACY}/proj_alpha/`))).toEqual([]);
    for (const [p, value] of before) if (!p.startsWith(`${LEGACY}/proj_alpha/`)) expect(files.get(p)).toBe(value);
    const result = await until(() => notices.find((el) => el.textContent === "Deleted 4 MB of old Studio history."), "the result notice");
    expect(result.isConnected).toBe(true);
    expect(document.querySelectorAll('[data-testid="notice.confirm"]')).toHaveLength(0);
    plugin.unload();
    await plugin.unloadPromise;
  });

  it("hides an unanswered offer on unload and deletes nothing", async () => {
    const { files, before, plugin } = await startInLegacyVault();

    plugin.unload();
    await plugin.unloadPromise;

    expect(document.querySelectorAll('[data-testid="notice.confirm"]')).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(files.has(CHECK_PATH)).toBe(false);
    for (const [p, value] of before) expect(files.get(p)).toBe(value);
  });
});
