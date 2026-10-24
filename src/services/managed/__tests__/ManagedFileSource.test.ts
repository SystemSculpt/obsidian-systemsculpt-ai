import { createHash } from "node:crypto";
import { createManagedFileSource } from "../ManagedFileSource";

const MiB = 1024 * 1024;

function fakeFile(sizeBytes: number) {
  let readBytes = 0;
  let largestRead = 0;
  let changed = false;
  const release = jest.fn();
  const source = {
    filename: "long-recording.m4a",
    contentType: "audio/mp4",
    sizeBytes,
    release,
    readSlice: async (start: number, end: number) => {
      // No backing file-sized buffer exists; bytes are synthesized on demand.
      if (end - start > MiB) throw new Error("Unbounded source read");
      readBytes += end - start;
      largestRead = Math.max(largestRead, end - start);
      const bytes = new Uint8Array(end - start);
      for (let i = 0; i < bytes.length; i++) bytes[i] = ((start + i) % 251) + (changed ? 1 : 0);
      return bytes.buffer;
    },
  };
  return { source, release, change: () => { changed = true; }, stats: () => ({ readBytes, largestRead }) };
}

describe("managed sliced file source", () => {
  it("hashes a large synthetic file incrementally and verifies unaligned upload slices without retaining it whole", async () => {
    const file = fakeFile(33 * MiB + 17);
    const source = createManagedFileSource("vault:long.m4a", () => file.source);
    const expected = createHash("sha256");
    for (let start = 0; start < file.source.sizeBytes; start += MiB) {
      expected.update(new Uint8Array(await file.source.readSlice(start, Math.min(start + MiB, file.source.sizeBytes))));
    }
    const before = file.stats().readBytes;
    await expect(source.fingerprint()).resolves.toBe(`sha256:${expected.digest("hex")}`);
    await source.fingerprint();
    expect(file.stats().readBytes - before).toBe(file.source.sizeBytes);
    const loaded = await source.load();
    expect(loaded).not.toHaveProperty("bytes");
    const start = MiB - 3;
    const part = new Uint8Array(await loaded.readSlice(start, 3 * MiB + 9));
    expect(part.byteLength).toBe(2 * MiB + 12);
    expect(part[0]).toBe(start % 251);
    expect(part.at(-1)).toBe((3 * MiB + 8) % 251);
    expect(file.stats().largestRead).toBe(MiB);
    source.release?.();
    source.release?.();
    await Promise.resolve();
    expect(file.release).toHaveBeenCalledTimes(1);
  });

  it("detects same-size changed bytes rather than uploading against an old fingerprint", async () => {
    const file = fakeFile(MiB + 5);
    const source = createManagedFileSource("vault:report.pdf", () => file.source);
    await source.fingerprint();
    file.change();
    await expect((await source.load()).readSlice(3, 5)).rejects.toThrow("changed");
    source.release?.();
  });

  it("stops hashing between slices when cancelled", async () => {
    const file = fakeFile(5 * MiB);
    const controller = new AbortController();
    const read = file.source.readSlice;
    file.source.readSlice = async (start, end) => {
      const bytes = await read(start, end);
      controller.abort();
      return bytes;
    };
    const source = createManagedFileSource("vault:long.m4a", () => file.source);
    await expect(source.fingerprint(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(file.stats().readBytes).toBe(MiB);
    source.release?.();
  });

  it("rejects short reads during hashing and upload", async () => {
    const file = fakeFile(10);
    const source = createManagedFileSource("vault:short.pdf", () => file.source);
    await source.fingerprint();
    file.source.readSlice = async () => new ArrayBuffer(1);
    await expect((await source.load()).readSlice(0, 10)).rejects.toThrow("changed");
    source.release?.();
    const next = createManagedFileSource("vault:short.pdf", () => file.source);
    await expect(next.fingerprint()).rejects.toThrow("changed");
    next.release?.();
  });

  it("releases a lazy source even when opening finishes after release", async () => {
    let resolve!: (value: ReturnType<typeof fakeFile>["source"]) => void;
    const file = fakeFile(4);
    const source = createManagedFileSource("vault:late.pdf", () => new Promise((done) => { resolve = done; }));
    const pending = source.load();
    await Promise.resolve();
    source.release?.();
    resolve(file.source);
    await pending;
    await Promise.resolve();
    expect(file.release).toHaveBeenCalledTimes(1);
    await expect(source.load()).rejects.toThrow("released");
  });
});
