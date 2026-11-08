import {
  AudioProcessorDeviceStaging,
  AudioProcessorDeviceStagingError,
} from "../AudioProcessorDeviceStaging";
import type { AudioProcessorAudioSource } from "../types";
import { sha256HexFromArrayBuffer } from "../../../utils/sha256";

class MemoryAdapter {
  readonly files = new Map<string, string | ArrayBuffer>();
  readonly directories = new Map<string, number>();
  readonly binaryWriteSizes: number[] = [];
  readonly binaryReadSizes: number[] = [];
  readonly calls: string[] = [];
  after?: (operation: string, path: string) => void;
  fail?: (operation: string, path: string) => boolean;

  private done<T>(operation: string, path: string, value: T): T {
    this.calls.push(operation);
    if (this.fail?.(operation, path)) throw new Error(`injected ${operation}`);
    this.after?.(operation, path);
    return value;
  }

  async exists(path: string): Promise<boolean> {
    return this.done("exists", path, this.files.has(path) || this.directories.has(path));
  }

  async stat(path: string): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null> {
    if (this.directories.has(path)) {
      const mtime = this.directories.get(path)!;
      return { type: "folder", ctime: mtime, mtime, size: 0 };
    }
    const value = this.files.get(path);
    if (value === undefined) return null;
    return {
      type: "file",
      ctime: 1,
      mtime: 1,
      size: typeof value === "string" ? value.length : value.byteLength,
    };
  }

  async mkdir(path: string): Promise<void> {
    this.directories.set(path, 1);
    this.done("mkdir", path, undefined);
  }

  async write(path: string, value: string): Promise<void> {
    this.files.set(path, value);
    this.done("write", path, undefined);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (typeof value !== "string") throw new Error(`Missing text file: ${path}`);
    return this.done("read", path, value);
  }

  async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
    this.binaryWriteSizes.push(value.byteLength);
    this.files.set(path, value.slice(0));
    this.done("writeBinary", path, undefined);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.files.get(path);
    if (!(value instanceof ArrayBuffer)) throw new Error(`Missing binary file: ${path}`);
    this.binaryReadSizes.push(value.byteLength);
    return this.done("readBinary", path, value.slice(0));
  }

  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`Missing source: ${from}`);
    if (this.files.has(to)) throw new Error(`Destination exists: ${to}`);
    if (this.fail?.("rename", to)) {
      this.calls.push("rename");
      throw new Error("injected rename");
    }
    this.files.set(to, value);
    this.files.delete(from);
    this.done("rename", to, undefined);
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    const descendants = [...this.files.keys()].filter((entry) => entry.startsWith(`${path}/`));
    if (!recursive && descendants.length > 0) throw new Error("Directory is not empty");
    for (const entry of descendants) this.files.delete(entry);
    for (const entry of [...this.directories.keys()]) {
      if (entry === path || entry.startsWith(`${path}/`)) this.directories.delete(entry);
    }
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    return this.done("list", path, {
      files: [...this.files.keys()].filter((entry) => {
        if (!entry.startsWith(prefix)) return false;
        return !entry.slice(prefix.length).includes("/");
      }),
      folders: [...this.directories.keys()].filter((entry) => {
        if (!entry.startsWith(prefix)) return false;
        return !entry.slice(prefix.length).includes("/");
      }),
    });
  }
}

function installedPlugin(adapter: MemoryAdapter) {
  return {
    app: { vault: { configDir: ".obsidian", adapter } },
    manifest: { id: "systemsculpt-ai", dir: ".obsidian/plugins/systemsculpt-ai" },
  } as any;
}

function source(value: Uint8Array): AudioProcessorAudioSource {
  return {
    filename: "long-audio.m4a",
    contentType: "audio/mp4",
    sizeBytes: value.byteLength,
    readSlice: jest.fn(async (start, end) => value.slice(start, end).buffer),
    release: jest.fn(),
  };
}

describe("AudioProcessorDeviceStaging", () => {
  it("writes beneath the literal installed directory without changing Unicode or spaces", async () => {
    const adapter = new MemoryAdapter();
    const plugin = installedPlugin(adapter);
    const configDir = " café config ";
    plugin.app.vault.configDir = configDir;
    plugin.manifest.dir = `${configDir}/plugins/systemsculpt-ai`;
    const staging = new AudioProcessorDeviceStaging(plugin);
    await staging.stage("audio_literal_path", source(new Uint8Array([1, 2, 3])));
    expect(adapter.files.size).toBeGreaterThan(0);
    expect([...adapter.files.keys()].every((path) => path.startsWith(
      `${configDir}/plugins/systemsculpt-ai/.audio-processor-staging/`,
    ))).toBe(true);
  });

  it("publishes bounded chunks and restores verified random-access reads after restart", async () => {
    const adapter = new MemoryAdapter();
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const writer = new AudioProcessorDeviceStaging(installedPlugin(adapter), {
      chunkSizeBytes: 4,
      now: () => 1,
    });

    const staged = await writer.stage("audio_job_device", source(bytes));
    const descriptor = staged.resumeDescriptor;
    expect(descriptor).toEqual(expect.objectContaining({
      kind: "staged",
      stagingId: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(adapter.binaryWriteSizes).toEqual([4, 4, 2]);
    expect(adapter.binaryReadSizes).toEqual([]);
    expect([...adapter.files.keys()].filter((path) => /chunk-\d+\.bin$/.test(path))).toHaveLength(3);
    expect([...adapter.files.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);

    const reader = new AudioProcessorDeviceStaging(installedPlugin(adapter), {
      chunkSizeBytes: 4,
      now: () => 2,
    });
    if (!descriptor || descriptor.kind !== "staged") throw new Error("Missing staged descriptor");
    const restored = await reader.open(descriptor);
    await expect(restored.readSlice(3, 9)).resolves.toEqual(
      new Uint8Array([3, 4, 5, 6, 7, 8]).buffer,
    );
    expect(adapter.binaryReadSizes.every((size) => size <= 4)).toBe(true);

    await reader.cleanupDescriptor(descriptor);
    expect([...adapter.files.keys()].some((path) => path.includes(descriptor.stagingId))).toBe(false);
  });

  it("does not expose a partial device source as restartable while its tail is still staging", async () => {
    const adapter = new MemoryAdapter();
    const plugin = installedPlugin(adapter);
    const staging = new AudioProcessorDeviceStaging(plugin, { chunkSizeBytes: 4 });
    const original = source(new Uint8Array([1, 2, 3, 4, 5]));
    const readSlice = original.readSlice;
    let tailRequested!: () => void;
    const tailStarted = new Promise<void>(resolve => { tailRequested = resolve; });
    let releaseTail!: () => void;
    const tailReady = new Promise<void>(resolve => { releaseTail = resolve; });
    original.readSlice = async (start, end) => {
      if (start === 4) {
        tailRequested();
        await tailReady;
      }
      return await readSlice(start, end);
    };
    const pending = staging.stage("audio_job_partial_tail", original);
    try {
      await tailStarted;
      expect(adapter.binaryWriteSizes).toEqual([4]);
      const restarted = new AudioProcessorDeviceStaging(plugin);
      await expect(restarted.openForJob("audio_job_partial_tail")).resolves.toBeNull();
      await expect(restarted.hasReadyForJob("audio_job_partial_tail")).resolves.toBe(false);
    } finally {
      releaseTail();
    }
    const staged = await pending;
    expect(staged.resumeDescriptor).toMatchObject({ kind: "staged" });
    const restarted = await new AudioProcessorDeviceStaging(plugin).openForJob("audio_job_partial_tail");
    await expect(restarted!.readSlice(0, 5)).resolves.toEqual(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    restarted!.release();
    staged.release();
    original.release();
  });

  it("rejects a corrupt chunk instead of uploading it", async () => {
    const adapter = new MemoryAdapter();
    const staging = new AudioProcessorDeviceStaging(installedPlugin(adapter), {
      chunkSizeBytes: 4,
      now: () => 1,
    });
    const staged = await staging.stage(
      "audio_job_corrupt",
      source(new Uint8Array([1, 2, 3, 4, 5])),
    );
    const chunk = [...adapter.files.keys()].find((path) => path.endsWith("chunk-000001.bin"));
    if (!chunk) throw new Error("Missing chunk");
    adapter.files.set(chunk, new Uint8Array([9, 9, 9, 9]).buffer);

    await expect(staged.readSlice(0, 4)).rejects.toBeInstanceOf(
      AudioProcessorDeviceStagingError,
    );
  });

  it("hashes each source chunk once while staging and verifies only the chunks consumed", async () => {
    const adapter = new MemoryAdapter();
    const digest = jest.fn(sha256HexFromArrayBuffer);
    const staging = new AudioProcessorDeviceStaging(installedPlugin(adapter), { chunkSizeBytes: 4, digest, now: () => 1 });
    const original = source(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const staged = await staging.stage("audio_job_io", original);
    expect(original.readSlice).toHaveBeenCalledTimes(3);
    expect(digest).toHaveBeenCalledTimes(5); // Job identity, three chunks, one recovery manifest.
    expect(adapter.binaryReadSizes).toEqual([]);
    await expect(staged.readSlice(4, 8)).resolves.toEqual(new Uint8Array([4, 5, 6, 7]).buffer);
    expect(adapter.binaryReadSizes).toEqual([4]);
    expect(digest).toHaveBeenCalledTimes(6);
  });

  it("rejects corruption introduced by a staging write at the consumption boundary", async () => {
    const adapter = new MemoryAdapter();
    adapter.after = (operation, path) => {
      if (operation === "writeBinary") adapter.files.set(path, new Uint8Array([9, 9, 9, 9]).buffer);
    };
    const staging = new AudioProcessorDeviceStaging(installedPlugin(adapter), { chunkSizeBytes: 4, now: () => 1 });
    const staged = await staging.stage("audio_job_write_corrupt", source(new Uint8Array([1, 2, 3, 4])));
    await expect(staged.readSlice(0, 4)).rejects.toMatchObject({ code: "staging_corrupt" });
  });

  it.each(["writeBinary", "rename"])("does not publish a partial source after a chunk %s failure", async (operation) => {
    const adapter = new MemoryAdapter();
    adapter.fail = (candidate, path) => candidate === operation && path.includes("chunk-000002.bin");
    const staging = new AudioProcessorDeviceStaging(installedPlugin(adapter), { chunkSizeBytes: 4, now: () => 1 });
    await expect(staging.stage("audio_job_partial", source(new Uint8Array([1, 2, 3, 4, 5])))).rejects.toThrow(`injected ${operation}`);
    adapter.fail = undefined;
    await expect(staging.openForJob("audio_job_partial")).resolves.toBeNull();
    const retried = await staging.stage("audio_job_partial", source(new Uint8Array([1, 2, 3, 4, 5])));
    await expect(retried.readSlice(0, 5)).resolves.toEqual(new Uint8Array([1, 2, 3, 4, 5]).buffer);
  });

  it("does not publish a source whose length changes while staging", async () => {
    const adapter = new MemoryAdapter();
    const original = source(new Uint8Array([1, 2, 3, 4, 5]));
    original.readSlice = async () => new Uint8Array([1]).buffer;
    const staging = new AudioProcessorDeviceStaging(installedPlugin(adapter), { chunkSizeBytes: 4, now: () => 1 });
    await expect(staging.stage("audio_job_short_read", original)).rejects.toMatchObject({ code: "staging_corrupt" });
    await expect(staging.openForJob("audio_job_short_read")).resolves.toBeNull();
  });

  it.each(["exists", "mkdir", "list", "write", "rename", "writeBinary", "read", "digest", "sourceRead"])(
    "fences staging cancellation after awaited %s", async (boundary) => {
      const adapter = new MemoryAdapter();
      const controller = new AbortController();
      adapter.after = operation => { if (operation === boundary) controller.abort(); };
      let digestCalls = 0;
      const digest = async (value: ArrayBuffer) => {
        const result = await sha256HexFromArrayBuffer(value);
        if (boundary === "digest" && ++digestCalls === 2) controller.abort();
        return result;
      };
      const original = source(new Uint8Array([1, 2, 3, 4, 5]));
      if (boundary === "sourceRead") {
        original.readSlice = async (start, end) => { controller.abort(); return new Uint8Array([1, 2, 3, 4, 5]).slice(start, end).buffer; };
      }
      const staging = new AudioProcessorDeviceStaging(installedPlugin(adapter), { chunkSizeBytes: 4, digest, now: () => 1 });
      await expect(staging.stage("audio_job_cancelled", original, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      const callsAtAbort = adapter.calls.length;
      await Promise.resolve();
      expect(adapter.calls).toHaveLength(callsAtAbort);
    },
  );

  it.each(["readBinary", "digest"])("fences cancellation during verified chunk %s", async boundary => {
    const adapter = new MemoryAdapter();
    const writer = new AudioProcessorDeviceStaging(installedPlugin(adapter), { chunkSizeBytes: 4, now: () => 1 });
    const staged = await writer.stage("audio_job_cancel_read", source(new Uint8Array([1, 2, 3, 4, 5])));
    const descriptor = staged.resumeDescriptor;
    if (!descriptor || descriptor.kind !== "staged") throw new Error("Missing descriptor");
    const controller = new AbortController();
    let cancelDigest = false;
    const reader = new AudioProcessorDeviceStaging(installedPlugin(adapter), {
      digest: async value => {
        const result = await sha256HexFromArrayBuffer(value);
        if (cancelDigest && boundary === "digest") controller.abort();
        return result;
      },
    });
    const restored = await reader.open(descriptor, controller.signal);
    cancelDigest = true;
    adapter.after = operation => { if (operation === boundary) controller.abort(); };
    await expect(restored.readSlice(0, 5)).rejects.toMatchObject({ name: "AbortError" });
    expect(adapter.binaryReadSizes).toEqual([4]);
  });

  it("opens historical audio manifests despite an incomplete newer generation and rejects descriptor tampering", async () => {
    const adapter = new MemoryAdapter();
    const stagingId = await sha256HexFromArrayBuffer(new TextEncoder().encode("audio-processor-device-staging-v1\0historical_job").buffer);
    const content = new Uint8Array([1, 2, 3]).buffer;
    const manifest = {
      schemaVersion: 1, sequence: 2, phase: "ready", stagingId, createdAt: 1,
      filename: "historical.m4a", contentType: "audio/mp4", sizeBytes: 3, chunkSizeBytes: 4,
      chunks: [{ index: 0, byteLength: 3, sha256: await sha256HexFromArrayBuffer(content) }],
    };
    const directory = `.obsidian/plugins/systemsculpt-ai/.audio-processor-staging/${stagingId}`;
    adapter.directories.set(directory, 1);
    adapter.files.set(`${directory}/chunk-000001.bin`, content);
    adapter.files.set(`${directory}/manifest-000002.json`, JSON.stringify(manifest));
    adapter.files.set(`${directory}/manifest-000003.json`, "{");
    adapter.files.set(`${directory}/manifest-000004.json.tmp`, "{}");
    const descriptor = { kind: "staged" as const, stagingId, manifestSha256: await sha256HexFromArrayBuffer(new TextEncoder().encode(JSON.stringify(manifest)).buffer) };
    const staging = new AudioProcessorDeviceStaging(installedPlugin(adapter));
    const restored = await staging.open(descriptor);
    await expect(restored.readSlice(0, 3)).resolves.toEqual(content);
    await expect(staging.openForJob("historical_job")).resolves.toMatchObject({ filename: "historical.m4a" });
    await expect(staging.open({ ...descriptor, manifestSha256: "0".repeat(64) })).rejects.toMatchObject({ code: "staging_corrupt" });
  });

  it("keeps active staging and removes inactive ready staging after its retention window", async () => {
    const adapter = new MemoryAdapter();
    const initial = new AudioProcessorDeviceStaging(installedPlugin(adapter), {
      chunkSizeBytes: 4,
      now: () => 1,
    });
    await initial.stage("audio_job_active", source(new Uint8Array([1, 2, 3])));
    await initial.stage("audio_job_stale", source(new Uint8Array([4, 5, 6])));
    const cleanup = new AudioProcessorDeviceStaging(installedPlugin(adapter), {
      chunkSizeBytes: 4,
      now: () => 8 * 24 * 60 * 60 * 1_000,
    });

    await cleanup.cleanupStale(["audio_job_active"]);

    await expect(cleanup.hasReadyForJob("audio_job_active")).resolves.toBe(true);
    await expect(cleanup.hasReadyForJob("audio_job_stale")).resolves.toBe(false);
  });
});
