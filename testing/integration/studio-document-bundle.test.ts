/** @jest-environment jsdom */
/**
 * Compiled Studio document round trip.
 *
 * Proves the shipped main.js can create, edit through the agent API, reopen
 * and merge one plain-JSON `.systemsculpt` file through an adapter without
 * desktop filesystem access, that it no longer ships a merge engine, and that
 * a project tab opens and survives a plugin reload while Studio's view code
 * loads only on first open.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createObsidianLeaf, type ObsidianLeaf } from "./obsidian-leaf";
import { captureStartupIdentity, expectProductionStartupIdentity } from "./startup-identity-assertions";

const BUNDLE_PATH = path.resolve(__dirname, "..", "..", "main.js");
const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "manifest.json");
const STUDIO_VIEW_TYPE = "systemsculpt-studio-view";

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function createPlugin(bundleModule: any, app: any): any {
  const PluginClass = bundleModule?.default ?? bundleModule;
  return new PluginClass(app, JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));
}

/** Onloads one evaluation of the bundle the way Obsidian starts a plugin. */
async function startPlugin(plugin: any): Promise<void> {
  await plugin.onload();
  await plugin.criticalInitializationPromise;
  await plugin.deferredInitializationPromise;
  await plugin.initializeManagers();
  plugin.ensureViewManager().initialize();
  await flushAsyncWork();
}

function inMemoryAdapter() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const missing = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  const adapter = {
    files,
    exists: async (p: string) => files.has(p) || dirs.has(p),
    mkdir: async (p: string) => { dirs.add(p); },
    read: async (p: string) => { if (!files.has(p)) throw missing(p); return files.get(p)!; },
    write: async (p: string, data: string) => { files.set(p, data); },
    readBinary: async (p: string) => { if (!files.has(p)) throw missing(p); return new TextEncoder().encode(files.get(p)!).buffer; },
    writeBinary: async (p: string, data: ArrayBuffer) => { files.set(p, new TextDecoder().decode(data)); },
    process: async (p: string, update: (raw: string) => string) => { const next = update(files.get(p) ?? ""); files.set(p, next); return next; },
    list: async () => ({ files: [...files.keys()], folders: [...dirs] }),
    remove: async (p: string) => { files.delete(p); },
    rmdir: async (p: string) => { for (const f of [...files.keys()]) if (f.startsWith(`${p}/`)) files.delete(f); dirs.delete(p); },
    rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
    stat: async () => null,
    trashLocal: async () => undefined,
  };
  return adapter;
}

describe("built bundle Studio document", () => {
  beforeAll(() => {
    if (!existsSync(BUNDLE_PATH)) throw new Error("Built bundle not found; run `npm run build` first.");
  });

  it("contains no embedded WebAssembly merge engine", () => {
    const bundle = readFileSync(BUNDLE_PATH, "utf8");
    expect(bundle).not.toMatch(/initializeBase64Wasm|__wbindgen/);
    // A base64 WebAssembly module starts with "\0asm" = "AGFzbQ".
    expect(bundle).not.toContain("AGFzbQ");
  });

  it("creates, edits, reopens and merges one plain-JSON document through the compiled plugin", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bundleModule = require(BUNDLE_PATH);
    const PluginClass = bundleModule?.default ?? bundleModule;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { App } = require("obsidian");
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    const app = new App();
    const adapter = inMemoryAdapter();
    app.vault.adapter = adapter;
    app.vault.getFiles = () => [...adapter.files.keys()].map((p) => ({ path: p }));
    const plugin = new PluginClass(app, manifest);
    // The compiled plugin exposes settings behind a getter; seed the backing field the way onload does.
    plugin._internal_settings_systemsculpt_plugin = { studioRunRetentionMaxRuns: 10, studioRunRetentionMaxArtifactsMb: 10 };
    const studio = plugin.getStudioService();

    const created = await studio.createProjectFile({ name: "Bundle Round Trip", projectPath: "Studio/Bundle Round Trip.systemsculpt" });
    const raw = adapter.files.get(created.path)!;
    expect(Object.keys(JSON.parse(raw))).toEqual(["schema", "id", "name", "docs", "canvas"]);
    expect([...adapter.files.keys()].filter((f) => f.includes(".tmp"))).toEqual([]);

    // The revision is the SHA-256 of the canonical file text.
    const read = await studio.readAgentDocument(created.path);
    expect(read.heads).toEqual([createHash("sha256").update(raw).digest("hex")]);

    const edited = await studio.editAgentDocument(created.path, read.heads, [
      { kind: "create", entityId: "node:note", value: { id: "note", kind: "text", x: 40, y: 60, config: { value: "Hello from the bundle" } } },
    ]);
    expect(edited.entities["node:note"]).toMatchObject({ id: "note", kind: "text" });
    expect(edited.heads).not.toEqual(read.heads);

    // Two independent edits from the same revision merge without conflict copies.
    const [left, right] = await Promise.all([
      studio.editAgentDocument(created.path, edited.heads, [{ kind: "set", entityId: "node:note", path: ["config", "value"], value: "Hello from the bundle, left" }]),
      studio.editAgentDocument(created.path, edited.heads, [{ kind: "set", entityId: "node:note", path: ["x"], value: 400 }]),
    ]);
    expect(left.heads).toHaveLength(1);
    expect(right.heads).toHaveLength(1);

    // A fresh plugin instance reopens the same bytes and observes both edits.
    const secondPlugin = new PluginClass(app, manifest);
    secondPlugin._internal_settings_systemsculpt_plugin = { studioRunRetentionMaxRuns: 10, studioRunRetentionMaxArtifactsMb: 10 };
    const reopened = secondPlugin.getStudioService();
    const final = await reopened.readAgentDocument(created.path);
    const note = final.entities["node:note"] as { x: number; config: { value: string } };
    expect(note.x).toBe(400);
    expect(note.config.value).toBe("Hello from the bundle, left");
    expect([...adapter.files.keys()].filter((f) => f.endsWith(".systemsculpt"))).toEqual([created.path]);
    expect([...adapter.files.keys()].some((f) => f.startsWith(".systemsculpt/studio/"))).toBe(false);
    await studio.dispose?.();
    await reopened.dispose?.();
  });

  it("opens a project in a tab Obsidian opens before Studio loads, and restores it after a plugin reload", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const host = require("obsidian");
    const app = new host.App();
    const adapter = inMemoryAdapter();
    app.vault.adapter = adapter;
    app.vault.getFiles = () => [...adapter.files.keys()].map((p) => ({ path: p }));
    const leaves: ObsidianLeaf[] = [];
    Object.assign(app.workspace, {
      getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.view?.getViewType() === type),
      iterateAllLeaves: (callback: (leaf: ObsidianLeaf) => void) => { leaves.forEach(callback); },
      getMostRecentLeaf: () => leaves[0] ?? null,
      getLeaf: jest.fn(),
      setActiveLeaf: jest.fn(),
    });
    const startupIdentity = captureStartupIdentity();
    let plugin = createPlugin(require(BUNDLE_PATH), app);
    await startPlugin(plugin);
    const opened: string[] = [];
    const handedOver: unknown[] = [];
    const leaf = createObsidianLeaf(host, app, (type) => plugin._views.get(type), (view: any) => {
      view.contentEl.onWindowMigrated = () => () => {};
      opened.push(view.constructor.name);
      const restoreReloadSnapshot = view.restoreReloadSnapshot?.bind(view);
      if (restoreReloadSnapshot) {
        view.restoreReloadSnapshot = (snapshot: unknown) => { handedOver.push(snapshot); return restoreReloadSnapshot(snapshot); };
      }
    });
    leaves.push(leaf);
    const created = await plugin.getStudioService().createProjectFile({ name: "Reload Tab", projectPath: "Studio/Reload Tab.systemsculpt" });

    // The way Obsidian opens a .systemsculpt file or a restored layout tab.
    await leaf.setViewState({ type: STUDIO_VIEW_TYPE, state: { file: created.path } });
    await flushAsyncWork();
    const firstView = leaf.view as any;
    expect(firstView.constructor.name).toBe("SystemSculptStudioView");
    expect(firstView.getState()).toMatchObject({ file: created.path });
    expect(firstView.getDisplayText()).toBe("Reload Tab.systemsculpt");
    expect(firstView.contentEl.querySelector(".ss-studio-view")).not.toBeNull();

    // A plugin reload: the old evaluation hands the tab over, Obsidian empties
    // the leaf, and a fresh evaluation with nothing loaded yet restores it.
    // (Obsidian's unload runs onunload; the host mock's skips it after onload.)
    plugin.onunload();
    await plugin.unloadPromise;
    await leaf.open(null);
    let nextBundle: any;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      nextBundle = require(BUNDLE_PATH);
    });
    plugin = createPlugin(nextBundle, app);
    await startPlugin(plugin);
    for (let attempt = 0; attempt < 20 && !leaf.view; attempt++) await flushAsyncWork();
    const restored = leaf.view as any;
    expect(restored).not.toBe(firstView);
    expect(restored.constructor).not.toBe(firstView.constructor);
    expect(restored.constructor.name).toBe("SystemSculptStudioView");
    expect(restored.getState()).toMatchObject({ file: created.path });
    expect(restored.contentEl.querySelector(".ss-studio-view")).not.toBeNull();
    expect(app.workspace.getLeaf).not.toHaveBeenCalled();
    // Both evaluations opened the tab through the placeholder, and the edit
    // handoff reached the real view rather than stopping at the placeholder.
    expect(opened).toEqual(["PendingStudioView", "SystemSculptStudioView", "PendingStudioView", "SystemSculptStudioView"]);
    expect(handedOver).toHaveLength(1);
    expect(handedOver[0]).toMatchObject({ project: { name: "Reload Tab" } });
    expectProductionStartupIdentity(startupIdentity, plugin.manifest.version);

    await leaf.detach();
    plugin.onunload();
    await plugin.unloadPromise;
  });
});
