/** @jest-environment jsdom */
/**
 * Compiled Studio document round trip.
 *
 * Proves the shipped main.js can create, edit through the agent API, reopen
 * and merge one plain-JSON `.systemsculpt` file through an adapter without
 * desktop filesystem access, and that it no longer ships a merge engine.
 */
import path from "node:path";
import { createHash } from "node:crypto";
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
});
