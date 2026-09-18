/** @jest-environment jsdom */
/**
 * Compiled Studio document round trip.
 *
 * Proves the shipped main.js initializes the embedded merge engine and can
 * create, edit through the agent API, reopen and merge one collaborative
 * `.systemsculpt` file through an adapter without desktop filesystem access.
 */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const BUNDLE_PATH = path.resolve(__dirname, "..", "..", "main.js");
const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "manifest.json");

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

describe("built bundle Studio collaborative document", () => {
  beforeAll(() => {
    if (!existsSync(BUNDLE_PATH)) throw new Error("Built bundle not found; run `npm run build` first.");
  });

  it("creates, edits, reopens and merges one collaborative document through the compiled plugin", async () => {
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
    const raw = JSON.parse(adapter.files.get(created.path)!);
    expect(raw.document?.engine).toBe("automerge");
    expect(raw.document?.heads).toHaveLength(1);
    expect([...adapter.files.keys()].filter((f) => f.includes(".tmp"))).toEqual([]);

    const read = await studio.readAgentDocument(created.path);
    expect(read.heads).toEqual(raw.document.heads);

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
    expect(left.heads.length + right.heads.length).toBeGreaterThan(0);

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
});
