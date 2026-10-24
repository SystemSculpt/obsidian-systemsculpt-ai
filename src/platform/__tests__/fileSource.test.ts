import { App, TFile } from "obsidian";
import { createDeviceFileSource, createVaultFileSource } from "../fileSource";
import { createManagedFileSource } from "../../services/managed/ManagedFileSource";

jest.mock("../desktopOnly", () => ({ hasNodeRuntime: () => false }));

function vaultFile() {
  const app = new App();
  const file = new TFile({ path: "recording.m4a", stat: { size: 10, mtime: 1 } });
  app.vault.getResourcePath = jest.fn(() => "capacitor://localhost/vault/recording.m4a");
  app.vault.readBinary = jest.fn(() => { throw new Error("Whole-file read"); });
  return { app, file };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

it("reads mobile vault resources by exact range without readBinary", async () => {
  const { app, file } = vaultFile();
  const fetcher = jest.fn(async () => new Response(new Uint8Array([3, 4, 5]), {
    status: 206, headers: { "Content-Range": "bytes 3-5/10" },
  }));
  globalThis.fetch = fetcher;
  const source = createVaultFileSource(app, file);
  expect([...new Uint8Array(await source.readSlice(3, 6))]).toEqual([3, 4, 5]);
  expect(fetcher).toHaveBeenCalledWith(expect.any(String), {
    headers: { Range: "bytes=3-5" }, signal: expect.any(AbortSignal),
  });
  expect(app.vault.readBinary).not.toHaveBeenCalled();
  source.release();
  await expect(source.readSlice(3, 6)).rejects.toMatchObject({ name: "AbortError" });
});

it("consumes one bounded stream when the mobile handler ignores Range, reopening for the upload pass", async () => {
  const { app, file } = vaultFile();
  const cancel = jest.fn();
  const arrayBuffer = jest.fn(() => { throw new Error("Whole response buffer"); });
  const fetcher = jest.fn(async () => {
    let offset = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (offset === 10) { controller.close(); return; }
        const next = Math.min(offset + 3, 10);
        controller.enqueue(Uint8Array.from({ length: next - offset }, (_, i) => offset + i));
        offset = next;
      },
      cancel,
    });
    const response = new Response(body);
    response.arrayBuffer = arrayBuffer;
    return response;
  });
  globalThis.fetch = fetcher;
  const source = createVaultFileSource(app, file);
  for (let start = 0; start < 10; start += 2) {
    expect([...new Uint8Array(await source.readSlice(start, start + 2))]).toEqual([start, start + 1]);
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect([...new Uint8Array(await source.readSlice(2, 5))]).toEqual([2, 3, 4]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  source.release();
  await Promise.resolve();
  expect(cancel).toHaveBeenCalled();
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(app.vault.readBinary).not.toHaveBeenCalled();
});

it("rejects mismatched ranges, short reads, and metadata changes", async () => {
  const { app, file } = vaultFile();
  const fetcher = jest.fn(async () => new Response(new Uint8Array([1]), {
    status: 206, headers: { "Content-Range": "bytes 0-1/10" },
  }));
  globalThis.fetch = fetcher;
  const source = createVaultFileSource(app, file);
  await expect(source.readSlice(3, 6)).rejects.toThrow("cannot read");
  await expect(source.readSlice(0, 2)).rejects.toThrow("changed");
  file.stat.mtime = 2;
  await expect(source.readSlice(0, 2)).rejects.toThrow("changed");
  expect(fetcher).toHaveBeenCalledTimes(2);
  source.release();
});

it("rejects a truncated full-response stream instead of returning a padded slice", async () => {
  const { app, file } = vaultFile();
  globalThis.fetch = jest.fn(async () => new Response(new Uint8Array([0, 1])));
  const source = createVaultFileSource(app, file);
  await expect(source.readSlice(0, 5)).rejects.toThrow("changed");
  source.release();
});

it.each([false, true])("rejects a grown full response with stale vault metadata (separate tail: %s)", async (separateTail) => {
  const { app, file } = vaultFile();
  globalThis.fetch = jest.fn(async () => new Response(new ReadableStream({
    start(controller) {
      if (separateTail) {
        controller.enqueue(new Uint8Array(10));
        controller.enqueue(new Uint8Array(2));
      } else {
        controller.enqueue(new Uint8Array(12));
      }
      controller.close();
    },
  })));
  const source = createVaultFileSource(app, file);
  await expect(source.readSlice(0, 10)).rejects.toThrow("changed");
  source.release();
});

it.each(["fingerprint", "upload"])("cancels a stalled mobile stream during %s", async (phase) => {
  const { app, file } = vaultFile();
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const cancel = jest.fn();
  let resourceSignal: AbortSignal | undefined;
  globalThis.fetch = jest.fn(async (_url, init) => {
    resourceSignal = init?.signal as AbortSignal;
    return new Response(new ReadableStream({ pull() { started(); }, cancel }));
  });
  if (phase === "upload") {
    (globalThis.fetch as jest.Mock).mockResolvedValueOnce(new Response(new Uint8Array(10)));
  }
  const source = createManagedFileSource("vault:recording.m4a", () => ({
    ...createVaultFileSource(app, file), filename: file.name, contentType: "audio/mp4",
  }));
  const controller = new AbortController();
  if (phase === "upload") await source.fingerprint(controller.signal);
  const pending = phase === "fingerprint"
    ? source.fingerprint(controller.signal)
    : (await source.load()).readSlice(0, 10);
  await reading;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(resourceSignal?.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(1);
  source.release?.();
});

it("slices device files and rejects invalid ranges without opening them", async () => {
  const slice = jest.fn(() => ({ arrayBuffer: async () => new Uint8Array([4, 5]).buffer }));
  const source = createDeviceFileSource({ size: 100, slice } as unknown as Blob);
  await expect(source.readSlice(4, 6)).resolves.toEqual(new Uint8Array([4, 5]).buffer);
  await expect(source.readSlice(-1, 5)).rejects.toThrow("Invalid");
  await expect(source.readSlice(99, 101)).rejects.toThrow("Invalid");
  expect(slice).toHaveBeenCalledTimes(1);
  source.release();
  await expect(source.readSlice(0, 1)).rejects.toThrow("released");
});
