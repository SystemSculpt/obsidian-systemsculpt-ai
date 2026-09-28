import { readVerifiedManagedOutput } from "../ManagedOutputBytes";

const expected = { size_bytes: 2, sha256: "a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222" };
const malformed = (reason: string): never => { throw new Error(reason); };

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

it("does not publish verified bytes if cancelled during the digest", async () => {
  const controller = new AbortController();
  const originalDigest = window.crypto.subtle.digest.bind(window.crypto.subtle);
  const digest = jest.spyOn(window.crypto.subtle, "digest").mockImplementation(async (...args) => {
    const hash = await originalDigest(...args);
    controller.abort();
    return hash;
  });
  try {
    await expect(readVerifiedManagedOutput(new Response(new Uint8Array([1, 2])), expected, controller.signal, malformed))
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
