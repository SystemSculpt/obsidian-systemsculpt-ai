import { sha256HexFromBytes } from "../../utils/sha256";

/** Reuses a complete response chunk, or joins partial chunks once, then verifies every byte. */
export async function readVerifiedManagedOutput(
  response: Response,
  expected: { size_bytes: number; sha256: string },
  signal: AbortSignal | undefined,
  malformed: (reason: string) => never,
): Promise<ArrayBuffer> {
  const abortError = () => new DOMException("Aborted", "AbortError");
  if (signal?.aborted) throw abortError();
  if (!response.body) malformed("integrity mismatch");
  const reader = response.body.getReader();
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  let offset = 0;
  let completed = false;
  const abortReader = () => { void reader.cancel(abortError()).catch(() => undefined); };
  signal?.addEventListener("abort", abortReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const chunk = await reader.read();
      if (signal?.aborted) throw abortError();
      if (chunk.done) { completed = true; break; }
      if (!(chunk.value instanceof Uint8Array)) malformed("body was malformed");
      if (chunk.value.byteLength > expected.size_bytes - offset) malformed("exceeded expected size");
      if (chunk.value.byteLength === 0) continue;
      if (!bytes) {
        // Native binary responses provide their complete buffer as one chunk.
        // A subview or a partial chunk needs an exact-sized owned destination.
        bytes = chunk.value.byteLength === expected.size_bytes
          && chunk.value.byteOffset === 0
          && chunk.value.byteLength === chunk.value.buffer.byteLength
          && chunk.value.buffer instanceof ArrayBuffer
          ? new Uint8Array(chunk.value.buffer)
          : new Uint8Array(expected.size_bytes);
      }
      if (bytes.buffer !== chunk.value.buffer) bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortReader);
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (offset !== expected.size_bytes) malformed("integrity mismatch");
  const verified = bytes ?? new Uint8Array(0);
  const hash = await sha256HexFromBytes(verified);
  if (signal?.aborted) throw abortError();
  if (hash !== expected.sha256) malformed("integrity mismatch");
  return verified.buffer;
}
