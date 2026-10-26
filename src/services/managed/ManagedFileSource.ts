import type { FileSource } from "../../platform/fileSource";
import { createSha256, sha256HexFromArrayBuffer } from "../../utils/sha256";
import { getRuntimeWindow } from "../../utils/runtimeWindow";

export type ManagedFileContent = FileSource & Readonly<{
  filename: string;
  contentType: string;
}>;

export type ManagedFileSource = Readonly<{
  identity: string;
  fingerprint(signal?: AbortSignal): string | Promise<string>;
  load(): Promise<ManagedFileContent>;
  release?(): void;
}>;

// A read window, not an input-size limit. Keep hashing independent of the
// server's multipart layout so existing SHA-256 recovery fingerprints survive.
const HASH_SLICE_BYTES = 1024 * 1024;

export function createManagedFileSource(
  identity: string,
  open: () => ManagedFileContent | Promise<ManagedFileContent>,
): ManagedFileSource {
  let pending: Promise<ManagedFileContent> | undefined;
  let fingerprint: Promise<string> | undefined;
  let released = false;
  let operationSignal: AbortSignal | undefined;
  const release = (): void => {
    if (released) return;
    released = true;
    operationSignal?.removeEventListener("abort", release);
    if (pending) void pending.then((source) => source.release()).catch(() => undefined);
    pending = undefined;
  };
  const readWindow = async (source: ManagedFileContent, start: number, end: number): Promise<ArrayBuffer> => {
    operationSignal?.throwIfAborted();
    try {
      const bytes = await source.readSlice(start, end);
      operationSignal?.throwIfAborted();
      return bytes;
    } catch (error) {
      operationSignal?.throwIfAborted();
      throw error;
    }
  };
  const ownerWindow = getRuntimeWindow();
  const digests = new Map<number, string>();
  const load = (): Promise<ManagedFileContent> => {
    if (released) return Promise.reject(new Error("The selected file was released."));
    return pending ??= Promise.resolve().then(open);
  };
  return {
    identity,
    load: async () => {
      const source = await load();
      return {
        ...source,
        readSlice: async (start, end) => {
          if (released) throw new Error("The selected file was released.");
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.sizeBytes) {
            throw new Error("Invalid file slice.");
          }
          const part = new Uint8Array(end - start);
          // Verify the bytes against the fingerprinted windows, even when a
          // writer preserves size/mtime or an upload part straddles windows.
          for (let offset = Math.floor(start / HASH_SLICE_BYTES) * HASH_SLICE_BYTES; offset < end; offset += HASH_SLICE_BYTES) {
            const windowEnd = Math.min(offset + HASH_SLICE_BYTES, source.sizeBytes);
            const bytes = await readWindow(source, offset, windowEnd);
            if (bytes.byteLength !== windowEnd - offset || await sha256HexFromArrayBuffer(bytes) !== digests.get(offset)) {
              throw new Error("The selected file changed while it was being read.");
            }
            const from = Math.max(start, offset);
            const to = Math.min(end, windowEnd);
            part.set(new Uint8Array(bytes, from - offset, to - from), from - start);
          }
          return part.buffer;
        },
      };
    },
    fingerprint: (signal) => fingerprint ??= (async () => {
      signal?.throwIfAborted();
      operationSignal = signal;
      operationSignal?.addEventListener("abort", release, { once: true });
      const source = await load();
      if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1) throw new Error("The selected file is empty or has an invalid size.");
      const hash = createSha256();
      for (let start = 0; start < source.sizeBytes; start += HASH_SLICE_BYTES) {
        signal?.throwIfAborted();
        const end = Math.min(start + HASH_SLICE_BYTES, source.sizeBytes);
        const bytes = await readWindow(source, start, end);
        signal?.throwIfAborted();
        if (bytes.byteLength !== end - start) throw new Error("The selected file changed while it was being read.");
        hash.update(new Uint8Array(bytes));
        digests.set(start, await sha256HexFromArrayBuffer(bytes));
        signal?.throwIfAborted();
        // Filesystem/mock reads may resolve without yielding a browser task.
        // Let Stop and the host UI run between windows of a long recording.
        if (end < source.sizeBytes) await new Promise<void>((resolve) => ownerWindow.setTimeout(resolve, 0));
      }
      return `sha256:${hash.digestHex()}`;
    })(),
    release,
  };
}
