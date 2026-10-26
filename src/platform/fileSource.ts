import type { App, TFile } from "obsidian";
import { desktopHost, hasNodeRuntime } from "./desktopOnly";

/** Local input bytes, read only for the requested range. The owner releases it. */
export type FileSource = Readonly<{
  sizeBytes: number;
  readSlice(start: number, end: number): Promise<ArrayBuffer>;
  release(): void;
}>;

function assertRange(start: number, end: number, size: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size) {
    throw new Error("Invalid file slice.");
  }
}

export function createDeviceFileSource(file: Blob): FileSource {
  let released = false;
  return {
    sizeBytes: file.size,
    readSlice: async (start, end) => {
      if (released) throw new Error("The selected file was released.");
      assertRange(start, end, file.size);
      return file.slice(start, end).arrayBuffer();
    },
    release: () => { released = true; },
  };
}

export function canReadVaultFileInParts(app: App): boolean {
  const adapter = app.vault.adapter as { getFullPath?: (path: string) => string };
  return hasNodeRuntime() && typeof adapter.getFullPath === "function";
}

export function createVaultFileSource(app: App, file: TFile): FileSource {
  const sizeBytes = file.stat.size;
  const modifiedAt = file.stat.mtime;
  const path = file.path;
  const assertUnchanged = (): void => {
    if (file.stat.size !== sizeBytes || file.stat.mtime !== modifiedAt || file.path !== path) {
      throw new Error("The selected vault file changed while it was being read.");
    }
  };
  if (canReadVaultFileInParts(app)) {
    const adapter = app.vault.adapter as unknown as { getFullPath(path: string): string };
    return createLocalFileSource(adapter.getFullPath(path), sizeBytes, modifiedAt, assertUnchanged);
  }

  // Ask the mobile vault resource handler for a byte range. If it ignores
  // Range, consume its stream only as far as needed, never a whole-file buffer.
  const controller = new AbortController();
  const ownerWindow = window.activeWindow ?? window;
  let stream: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let position = 0;
  let remainder: Uint8Array | undefined;
  const closeStream = async (): Promise<void> => {
    const reader = stream;
    stream = undefined;
    remainder = undefined;
    position = 0;
    await reader?.cancel();
  };
  return {
    sizeBytes,
    readSlice: async (start, end) => {
      controller.signal.throwIfAborted();
      assertRange(start, end, sizeBytes);
      assertUnchanged();
      if (start === end) return new ArrayBuffer(0);
      if (stream && start < position) await closeStream();
      if (!stream) {
        // Local vault resource, not an HTTP service: requestUrl buffers the whole
        // response and cannot stream the host's local resource scheme.
        const response = await ownerWindow.fetch(app.vault.getResourcePath(file), {
          headers: { Range: `bytes=${start}-${end - 1}` },
          signal: controller.signal,
        });
        if (response.status === 206 && response.headers.get("Content-Range") === `bytes ${start}-${end - 1}/${sizeBytes}`) {
          const bytes = await response.arrayBuffer();
          controller.signal.throwIfAborted();
          assertUnchanged();
          if (bytes.byteLength !== end - start) throw new Error("The selected vault file changed while it was being read.");
          return bytes;
        }
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel();
          throw new Error("This host cannot read the vault file in parts. Choose the file from Device instead.");
        }
        stream = response.body.getReader();
      }
      const reader = stream;
      const slice = new Uint8Array(end - start);
      try {
        while (position < end) {
          controller.signal.throwIfAborted();
          const chunk = remainder ? { value: remainder, done: false } : await reader.read();
          remainder = undefined;
          if (chunk.done || !chunk.value) throw new Error("The selected vault file changed while it was being read.");
          const next = position + chunk.value.byteLength;
          if (next > start) {
            const from = Math.max(start, position);
            const to = Math.min(end, next);
            slice.set(chunk.value.subarray(from - position, to - position), from - start);
          }
          if (next > end) remainder = chunk.value.subarray(end - position);
          position = Math.min(next, end);
        }
        controller.signal.throwIfAborted();
        assertUnchanged();
        if (end === sizeBytes) {
          if (remainder?.byteLength) throw new Error("The selected vault file changed while it was being read.");
          // A stale TFile size must not silently turn a grown recording into
          // its old prefix. Verify EOF before accepting the final window.
          let tail = await reader.read();
          while (!tail.done && tail.value.byteLength === 0) tail = await reader.read();
          if (!tail.done) throw new Error("The selected vault file changed while it was being read.");
          controller.signal.throwIfAborted();
          await closeStream();
        }
        return slice.buffer;
      } catch (error) {
        await closeStream();
        throw error;
      }
    },
    release: () => {
      controller.abort();
      void closeStream().catch(() => undefined);
    },
  };
}

/** Uses the same positioned reads as Audio Processor, including mutation checks. */
export function createLocalFileSource(
  absolutePath: string,
  sizeBytes: number,
  modifiedAt: number,
  assertUnchanged: () => void = () => undefined,
): FileSource {
  type DesktopFs = Awaited<ReturnType<typeof desktopHost.fs>>;
  type DesktopFileHandle = Awaited<ReturnType<DesktopFs["open"]>>;
  let handlePromise: Promise<DesktopFileHandle> | null = null;
  let released = false;
  const loadHandle = async (): Promise<DesktopFileHandle> => {
    if (released) throw new Error("The selected file was released.");
    handlePromise ??= (async () => {
      const fs = await desktopHost.fs();
      if (released) throw new Error("The selected file was released.");
      return fs.open(absolutePath, "r");
    })();
    return handlePromise;
  };
  const check = async (handle: DesktopFileHandle): Promise<void> => {
    if (released) throw new Error("The selected file was released.");
    assertUnchanged();
    const stat = await handle.stat();
    if (stat.size !== sizeBytes || Math.abs(stat.mtimeMs - modifiedAt) > 2) {
      throw new Error("The selected file changed while it was being read.");
    }
  };
  return {
    sizeBytes,
    readSlice: async (start, end) => {
      assertRange(start, end, sizeBytes);
      const handle = await loadHandle();
      await check(handle);
      const bytes = new Uint8Array(end - start);
      let totalRead = 0;
      while (totalRead < bytes.byteLength) {
        const result = await handle.read(bytes, totalRead, bytes.byteLength - totalRead, start + totalRead);
        if (result.bytesRead <= 0) throw new Error("The selected file changed while it was being read.");
        totalRead += result.bytesRead;
      }
      await check(handle);
      return bytes.buffer;
    },
    release: () => {
      released = true;
      const pending = handlePromise;
      handlePromise = null;
      if (pending) void pending.then((handle) => handle.close()).catch(() => undefined);
    },
  };
}
