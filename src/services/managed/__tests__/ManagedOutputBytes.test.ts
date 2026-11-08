import { createHash } from "crypto";
import { requestUrl } from "obsidian";
import { PlatformRequestClient } from "../../PlatformRequestClient";
import { readVerifiedManagedOutput } from "../ManagedOutputBytes";

jest.mock("obsidian", () => ({
  ...jest.requireActual("obsidian"),
  requestUrl: jest.fn(),
}));

const expected = { size_bytes: 2, sha256: "a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222" };
const malformed = (reason: string): never => { throw new Error(reason); };

async function nativeResponse(bytes: ArrayBuffer): Promise<Response> {
  (requestUrl as jest.Mock).mockResolvedValueOnce({ status: 200, headers: {}, arrayBuffer: bytes });
  return new PlatformRequestClient().request({
    url: "https://api.test/output", method: "GET", responseEncoding: "arrayBuffer", maxResponseBytes: bytes.byteLength,
  });
}

it("returns the original native download buffer after complete SHA-256 verification", async () => {
  const bytes = new Uint8Array(128 * 1024).fill(7).buffer;
  const metadata = { size_bytes: bytes.byteLength, sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex") };
  const response = await nativeResponse(bytes);
  expect(await readVerifiedManagedOutput(response, metadata, undefined, malformed) === bytes).toBe(true);
  expect(response.bodyUsed).toBe(true);
  expect(response.body?.locked).toBe(false);
});

it("rejects an interior corrupt byte in a same-size native download", async () => {
  const bytes = new Uint8Array(128 * 1024).fill(7);
  const metadata = { size_bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  bytes[65_537] ^= 1;
  await expect(readVerifiedManagedOutput(await nativeResponse(bytes.buffer), metadata, undefined, malformed))
    .rejects.toThrow("integrity mismatch");
});

it.each([
  [[1], "integrity mismatch"],
  [[1, 2, 3], "exceeded expected size"],
] as const)("rejects a native body with the wrong size: %p", async (values, message) => {
  await expect(readVerifiedManagedOutput(await nativeResponse(new Uint8Array(values).buffer), expected, undefined, malformed))
    .rejects.toThrow(message);
});

it("joins partial chunks into one exact buffer", async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.enqueue(new Uint8Array([2]));
      controller.close();
    },
  }));
  const result = await readVerifiedManagedOutput(response, expected, undefined, malformed);
  expect([...new Uint8Array(result)]).toEqual([1, 2]);
  expect(response.body?.locked).toBe(false);
});

it("copies a partial backing-buffer view without returning unrelated bytes", async () => {
  const backing = new Uint8Array([9, 1, 2, 9]);
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(backing.subarray(1, 3)); controller.close(); },
  }));
  const result = await readVerifiedManagedOutput(response, expected, undefined, malformed);
  expect(result).not.toBe(backing.buffer);
  expect([...new Uint8Array(result)]).toEqual([1, 2]);
});

it("rejects trailing bytes after an exact first chunk and cancels the stream", async () => {
  const cancel = jest.fn();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3])); },
    cancel,
  }));
  await expect(readVerifiedManagedOutput(response, expected, undefined, malformed)).rejects.toThrow("exceeded expected size");
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(response.body?.locked).toBe(false);
});

it("does not accept an exact first chunk before the stream finishes successfully", async () => {
  const failure = new Error("download interrupted");
  let reads = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2]));
      else controller.error(failure);
    },
  }));
  await expect(readVerifiedManagedOutput(response, expected, undefined, malformed)).rejects.toBe(failure);
  expect(response.body?.locked).toBe(false);
});

it("cancels a pending stream read and releases its lock without waiting for another chunk", async () => {
  const controller = new AbortController();
  const cancel = jest.fn();
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const body = new ReadableStream<Uint8Array>({ pull() { reading(); }, cancel });
  const pending = readVerifiedManagedOutput(new Response(body), expected, controller.signal, malformed);
  await started;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
});

it.each(["stream", "native"])("does not publish verified %s bytes if cancelled during the digest", async (transport) => {
  const controller = new AbortController();
  const originalDigest = window.crypto.subtle.digest.bind(window.crypto.subtle);
  const digest = jest.spyOn(window.crypto.subtle, "digest").mockImplementation(async (...args) => {
    const hash = await originalDigest(...args);
    controller.abort();
    return hash;
  });
  try {
    const bytes = new Uint8Array([1, 2]);
    const response = transport === "native" ? await nativeResponse(bytes.buffer) : new Response(bytes);
    await expect(readVerifiedManagedOutput(response, expected, controller.signal, malformed))
      .rejects.toMatchObject({ name: "AbortError" });
  } finally {
    digest.mockRestore();
  }
});

it("rejects a same-size corrupt body and releases its stream lock", async () => {
  const response = new Response(new Uint8Array([2, 1]));
  await expect(readVerifiedManagedOutput(response, expected, undefined, malformed)).rejects.toThrow("integrity mismatch");
  expect(response.body?.locked).toBe(false);
});
