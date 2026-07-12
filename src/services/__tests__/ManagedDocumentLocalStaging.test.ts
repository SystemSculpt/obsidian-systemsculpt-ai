import { ManagedDocumentLocalStaging, ManagedDocumentLocalStagingError } from "../managed/ManagedDocumentLocalStaging";

class MemoryAdapter {
  files = new Map<string, string | ArrayBuffer>();
  directories = new Set<string>();
  async exists(path: string) { return this.files.has(path) || this.directories.has(path); }
  async mkdir(path: string) { this.directories.add(path); }
  async write(path: string, value: string) { this.files.set(path, value); }
  async read(path: string) { const value = this.files.get(path); if (typeof value !== "string") throw new Error("missing"); return value; }
  async writeBinary(path: string, value: ArrayBuffer) { this.files.set(path, value.slice(0)); }
  async readBinary(path: string) { const value = this.files.get(path); if (!(value instanceof ArrayBuffer)) throw new Error("missing"); return value.slice(0); }
  async rename(from: string, to: string) { const value = this.files.get(from); if (value === undefined) throw new Error("missing"); this.files.set(to, value); this.files.delete(from); }
  async remove(path: string) { this.files.delete(path); }
  async rmdir(path: string) { for (const key of [...this.files.keys()]) if (key.startsWith(`${path}/`)) this.files.delete(key); this.directories.delete(path); }
}

const bytes = (value: string) => new TextEncoder().encode(value).buffer;

describe("ManagedDocumentLocalStaging", () => {
  it("writes opaque verified artifacts and a redacted manifest through the adapter", async () => {
    const adapter = new MemoryAdapter();
    const staging = new ManagedDocumentLocalStaging(adapter as any, ".obsidian/plugins/systemsculpt-ai");

    const metadata = await staging.stage("operation-secret-name", [
      { kind: "markdown", bytes: bytes("# private output") },
      { kind: "image", bytes: bytes("private image") },
    ]);

    expect(metadata).toHaveLength(2);
    expect(metadata.every((item) => /^[a-f0-9]{64}$/.test(item.id))).toBe(true);
    expect([...adapter.files.keys()].join("\n")).not.toContain("operation-secret-name");
    const manifest = [...adapter.files.entries()].find(([path]) => path.endsWith("manifest.json"))?.[1];
    expect(String(manifest)).not.toContain("private output");
    expect(String(manifest)).not.toContain("private image");
    const restored = await staging.readVerified("operation-secret-name", metadata);
    expect(new TextDecoder().decode(restored[0])).toBe("# private output");
  });

  it("blocks corrupt staged bytes instead of returning them", async () => {
    const adapter = new MemoryAdapter();
    const staging = new ManagedDocumentLocalStaging(adapter as any, ".obsidian/plugins/systemsculpt-ai");
    const metadata = await staging.stage("operation-1", [{ kind: "markdown", bytes: bytes("good") }]);
    const artifactPath = [...adapter.files.keys()].find((path) => path.endsWith(metadata[0].id))!;
    adapter.files.set(artifactPath, bytes("evil"));

    await expect(staging.readVerified("operation-1", metadata)).rejects.toMatchObject({ code: "local_staging_corrupt" });
  });

  it("rejects traversal and honors cancellation before adapter writes", async () => {
    expect(() => new ManagedDocumentLocalStaging(new MemoryAdapter() as any, "../plugins/systemsculpt-ai"))
      .toThrow(ManagedDocumentLocalStagingError);
    const adapter = new MemoryAdapter();
    const staging = new ManagedDocumentLocalStaging(adapter as any, ".obsidian/plugins/systemsculpt-ai");
    const controller = new AbortController();
    controller.abort();
    await expect(staging.stage("operation-1", [{ kind: "markdown", bytes: bytes("data") }], controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(adapter.files.size).toBe(0);
  });

  it("removes only the opaque operation directory during cleanup", async () => {
    const adapter = new MemoryAdapter();
    const staging = new ManagedDocumentLocalStaging(adapter as any, ".obsidian/plugins/systemsculpt-ai");
    await staging.stage("operation-1", [{ kind: "markdown", bytes: bytes("data") }]);
    await staging.cleanup("operation-1");
    expect([...adapter.files.keys()].some((path) => path.includes("manifest.json"))).toBe(false);
  });
});
