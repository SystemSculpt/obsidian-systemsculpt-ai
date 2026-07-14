class BundleMemoryAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  async exists(path: string): Promise<boolean> { return this.files.has(path) || this.dirs.has(path); }
  async read(path: string): Promise<string> { const bytes = this.files.get(path); if (!bytes) throw new Error(`missing ${path}`); return new TextDecoder().decode(bytes); }
  async readBinary(path: string): Promise<ArrayBuffer> { const bytes = this.files.get(path); if (!bytes) throw new Error(`missing ${path}`); return bytes.slice().buffer; }
  async write(path: string, data: string): Promise<void> { this.files.set(path, new TextEncoder().encode(data)); }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> { this.files.set(path, new Uint8Array(data.slice(0))); }
  async mkdir(path: string): Promise<void> { this.dirs.add(path); }
  async remove(path: string): Promise<void> { this.files.delete(path); for (const file of [...this.files.keys()]) if (file.startsWith(`${path}/`)) this.files.delete(file); }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path ? `${path}/` : ""; const files: string[] = []; const folders = new Set<string>();
    for (const file of this.files.keys()) { if (!file.startsWith(prefix)) continue; const tail = file.slice(prefix.length); const slash = tail.indexOf("/"); if (slash < 0) files.push(file); else folders.add(`${prefix}${tail.slice(0, slash)}`); }
    for (const dir of this.dirs) { if (!dir.startsWith(prefix) || dir === path) continue; const first = dir.slice(prefix.length).split("/")[0]; if (first) folders.add(`${prefix}${first}`); }
    return { files: files.sort(), folders: [...folders].sort() };
  }
}

type BuiltGenerationModule = {
  StudioProjectGenerationStore: new (adapter: any, options?: any) => any;
  ObsidianStudioGenerationAdapter: new (adapter: any) => any;
};

export async function exerciseBuiltStudioGenerations(bundleModule: BuiltGenerationModule): Promise<void> {
  expect(typeof bundleModule.StudioProjectGenerationStore).toBe("function");
  expect(typeof bundleModule.ObsidianStudioGenerationAdapter).toBe("function");
  const dataAdapter = new BundleMemoryAdapter();
  const productionAdapter = new bundleModule.ObsidianStudioGenerationAdapter(dataAdapter);
  const locator = { vaultRelativeProjectPath: "SystemSculpt/Studio/Bundle Proof.systemsculpt" };
  const projectId = "bundle_project";
  const projectDocument = new TextEncoder().encode(JSON.stringify({ schema: "studio.project.v1", projectId, name: "Bundle Proof" }));
  const policyDocument = new TextEncoder().encode(JSON.stringify({ schema: "studio.policy.v1", version: 1, updatedAt: "2026-07-11T00:00:00.000Z", grants: [] }));
  const projectManifest = new TextEncoder().encode(JSON.stringify({ schema: "studio.manifest.v1", projectId }));
  const store = new bundleModule.StudioProjectGenerationStore(productionAdapter, { now: () => "2026-07-11T00:00:00.000Z" });
  const created = await store.create({ kind: "create", projectId, projectDocument, policyDocument, projectManifest }, locator);
  expect(created.status).toBe("committed");
  if (created.status !== "committed") throw new Error("built generation create failed");
  const hash = "a".repeat(64);
  const binary = new Uint8Array([0, 1, 2, 127, 128, 255]);
  const committed = await store.commitWholeGeneration({ kind: "put_asset", projectId, asset: { contentAddressedPath: `aa/${hash}.bin`, bytes: binary } }, created.expectedGeneration);
  expect(committed.status).toBe("committed");

  const restarted = new bundleModule.StudioProjectGenerationStore(new bundleModule.ObsidianStudioGenerationAdapter(dataAdapter));
  const recovered = await restarted.open(projectId, locator);
  expect(recovered.status).toBe("ready");
  if (recovered.status !== "ready") throw new Error("built generation recovery failed");
  expect(recovered.expectedGeneration.revision).toBe(1);
  expect(recovered.expectedGeneration.generationHash).toMatch(/^[0-9a-f]{64}$/);
  expect(recovered.generation.files.get(`support/assets/sha256/aa/${hash}.bin`)).toEqual(binary);
}
