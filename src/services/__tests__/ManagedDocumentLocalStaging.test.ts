import { ManagedDocumentLocalStaging, ManagedDocumentLocalStagingError } from "../managed/ManagedDocumentLocalStaging";

class MemoryAdapter {
  files = new Map<string, string | ArrayBuffer>();
  directories = new Set<string>();
  calls: string[] = [];
  after?: (operation: string) => void;
  fail?: (operation: string) => boolean;
  private done<T>(operation: string, value: T): T { this.calls.push(operation); if (this.fail?.(operation)) throw new Error(`injected ${operation}`); this.after?.(operation); return value; }
  async exists(path: string) { return this.done("exists", this.files.has(path) || this.directories.has(path)); }
  async mkdir(path: string) { this.directories.add(path); this.done("mkdir", undefined); }
  async write(path: string, value: string) { this.files.set(path, value); this.done("write", undefined); }
  async read(path: string) { const value = this.files.get(path); if (typeof value !== "string") throw new Error("missing"); return this.done("read", value); }
  async writeBinary(path: string, value: ArrayBuffer) { this.files.set(path, value.slice(0)); this.done("writeBinary", undefined); }
  async readBinary(path: string) { const value = this.files.get(path); if (!(value instanceof ArrayBuffer)) throw new Error("missing"); return this.done("readBinary", value.slice(0)); }
  async rename(from: string, to: string) { const value = this.files.get(from); if (value === undefined) throw new Error("missing"); if (this.fail?.("rename")) { this.calls.push("rename"); throw new Error("injected rename"); } this.files.set(to, value); this.files.delete(from); this.calls.push("rename"); this.after?.("rename"); }
  async remove(path: string) { this.files.delete(path); this.done("remove", undefined); }
  async rmdir(path: string) { for (const key of [...this.files.keys()]) if (key.startsWith(`${path}/`)) this.files.delete(key); this.directories.delete(path); this.done("rmdir", undefined); }
  async list(path: string) { return this.done("list", { files: [...this.files.keys()].filter((key) => key.startsWith(`${path}/`)), folders: [] }); }
}

const bytes = (value: string) => new TextEncoder().encode(value).buffer;
const installedPlugin = (adapter: MemoryAdapter) => ({
  app: { vault: { configDir: ".obsidian", adapter } },
  manifest: { id: "systemsculpt-ai", dir: ".obsidian/plugins/systemsculpt-ai" },
}) as any;

describe("ManagedDocumentLocalStaging", () => {
  it("derives the opaque root from installed plugin identity and rejects caller-selected roots", async () => {
    const adapter = new MemoryAdapter();
    const staging = new ManagedDocumentLocalStaging(installedPlugin(adapter));
    await staging.stage("operation-secret-name", [{ kind: "markdown", bytes: bytes("private") }]);
    expect([...adapter.files.keys()].every((path) => path.startsWith(".obsidian/plugins/systemsculpt-ai/.managed-document-staging/"))).toBe(true);
    const callsBefore = adapter.calls.length;
    expect(() => new ManagedDocumentLocalStaging({
      adapter,
      configDirectory: "alternate",
      pluginManifest: { id: "systemsculpt-ai", dir: "alternate/plugins/systemsculpt-ai" },
    } as any)).toThrow(ManagedDocumentLocalStagingError);
    expect(() => new ManagedDocumentLocalStaging({
      app: { vault: { configDir: ".obsidian", adapter } },
      manifest: { id: "alternate-plugin", dir: ".obsidian/plugins/alternate-plugin" },
    } as any)).toThrow(ManagedDocumentLocalStagingError);
    expect(adapter.calls).toHaveLength(callsBefore);
  });

  it("writes opaque verified artifacts and redacted immutable manifest generations", async () => {
    const adapter = new MemoryAdapter();
    const staging = new ManagedDocumentLocalStaging(installedPlugin(adapter));
    const metadata = await staging.stage("operation-secret-name", [
      { kind: "markdown", bytes: bytes("# private output") },
      { kind: "image", bytes: bytes("private image") },
    ]);
    const paths = [...adapter.files.keys()];
    expect(paths.join("\n")).not.toContain("operation-secret-name");
    expect(paths.filter((path) => /manifest-\d{6}\.json$/.test(path))).toHaveLength(4);
    expect(adapter.calls).not.toContain("remove");
    const manifests = [...adapter.files.entries()].filter(([path]) => path.includes("manifest-")).map(([, value]) => String(value));
    expect(manifests.join("\n")).not.toMatch(/private output|private image/);
    const restored = await staging.readVerified("operation-secret-name", metadata);
    expect(new TextDecoder().decode(restored[0])).toBe("# private output");
  });

  it("keeps the previous valid manifest selectable when a later generation write or rename fails", async () => {
    const adapter = new MemoryAdapter();
    const staging = new ManagedDocumentLocalStaging(installedPlugin(adapter));
    const metadata = await staging.stage("operation-1", [{ kind: "markdown", bytes: bytes("good") }]);
    const validManifestCount = [...adapter.files.keys()].filter((path) => /manifest-\d{6}\.json$/.test(path)).length;
    adapter.fail = (operation) => operation === "rename";
    await expect(staging.stage("operation-1", [{ kind: "markdown", bytes: bytes("new") }])).rejects.toThrow("injected rename");
    expect([...adapter.files.keys()].filter((path) => /manifest-\d{6}\.json$/.test(path))).toHaveLength(validManifestCount);
    adapter.fail = undefined;
    await expect(staging.readVerified("operation-1", metadata)).resolves.toHaveLength(1);
  });

  it("ignores a corrupt newest immutable manifest and selects an older valid ready generation", async () => {
    const adapter = new MemoryAdapter();
    const staging = new ManagedDocumentLocalStaging(installedPlugin(adapter));
    const metadata = await staging.stage("operation-1", [{ kind: "markdown", bytes: bytes("good") }]);
    const directory = [...adapter.directories].find((path) => path.includes(".managed-document-staging/") && !path.endsWith("staging"))!;
    adapter.files.set(`${directory}/manifest-999999.json`, "{");
    await expect(staging.readVerified("operation-1", metadata)).resolves.toHaveLength(1);
  });

  it("blocks corrupt staged bytes instead of returning them", async () => {
    const adapter = new MemoryAdapter();
    const staging = new ManagedDocumentLocalStaging(installedPlugin(adapter));
    const metadata = await staging.stage("operation-1", [{ kind: "markdown", bytes: bytes("good") }]);
    const artifactPath = [...adapter.files.keys()].find((path) => path.endsWith(metadata[0].id))!;
    adapter.files.set(artifactPath, bytes("evil"));
    await expect(staging.readVerified("operation-1", metadata)).rejects.toMatchObject({ code: "local_staging_corrupt" });
  });

  it.each(["exists", "mkdir", "list", "write", "rename", "writeBinary", "readBinary", "digest"])(
    "fences cancellation immediately after awaited %s boundaries",
    async (boundary) => {
      const adapter = new MemoryAdapter();
      const controller = new AbortController();
      let digestCalls = 0;
      const digest = async (value: ArrayBuffer) => {
        const result = await crypto.subtle.digest("SHA-256", value);
        digestCalls += 1;
        if (boundary === "digest" && digestCalls === 2) controller.abort();
        return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
      };
      adapter.after = (operation) => { if (operation === boundary) controller.abort(); };
      const staging = new ManagedDocumentLocalStaging(installedPlugin(adapter), { digest });
      await expect(staging.stage("operation-1", [{ kind: "markdown", bytes: bytes("data") }], controller.signal))
        .rejects.toMatchObject({ name: "AbortError" });
      const callsAtAbort = adapter.calls.length;
      await Promise.resolve();
      expect(adapter.calls).toHaveLength(callsAtAbort);
    }
  );

  it.each(["list", "read", "readBinary", "digest"])("fences verified reads after awaited %s", async (boundary) => {
    const adapter = new MemoryAdapter();
    const staging = new ManagedDocumentLocalStaging(installedPlugin(adapter));
    const metadata = await staging.stage("operation-1", [{ kind: "markdown", bytes: bytes("data") }]);
    const controller = new AbortController();
    let digestCalls = 0;
    const digest = async (value: ArrayBuffer) => {
      const result = await crypto.subtle.digest("SHA-256", value);
      digestCalls += 1;
      if (boundary === "digest" && digestCalls === 1) controller.abort();
      return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    adapter.after = (operation) => { if (operation === boundary) controller.abort(); };
    const reader = new ManagedDocumentLocalStaging(installedPlugin(adapter), { digest });
    await expect(reader.readVerified("operation-1", metadata, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
