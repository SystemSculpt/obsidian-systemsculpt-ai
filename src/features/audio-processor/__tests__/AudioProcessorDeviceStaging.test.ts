import {
  AudioProcessorDeviceStaging,
  AudioProcessorDeviceStagingError,
} from "../AudioProcessorDeviceStaging";
import type { AudioProcessorAudioSource } from "../types";

class MemoryAdapter {
  readonly files = new Map<string, string | ArrayBuffer>();
  readonly directories = new Map<string, number>();
  readonly binaryWriteSizes: number[] = [];
  readonly binaryReadSizes: number[] = [];

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
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
  }

  async write(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (typeof value !== "string") throw new Error(`Missing text file: ${path}`);
    return value;
  }

  async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
    this.binaryWriteSizes.push(value.byteLength);
    this.files.set(path, value.slice(0));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.files.get(path);
    if (!(value instanceof ArrayBuffer)) throw new Error(`Missing binary file: ${path}`);
    this.binaryReadSizes.push(value.byteLength);
    return value.slice(0);
  }

  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`Missing source: ${from}`);
    if (this.files.has(to)) throw new Error(`Destination exists: ${to}`);
    this.files.set(to, value);
    this.files.delete(from);
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
    return {
      files: [...this.files.keys()].filter((entry) => {
        if (!entry.startsWith(prefix)) return false;
        return !entry.slice(prefix.length).includes("/");
      }),
      folders: [...this.directories.keys()].filter((entry) => {
        if (!entry.startsWith(prefix)) return false;
        return !entry.slice(prefix.length).includes("/");
      }),
    };
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
  it("publishes verified bounded chunks and restores random-access reads after restart", async () => {
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
