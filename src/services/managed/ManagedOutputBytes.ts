/** Reads one verified output without retaining both chunks and a joined copy. */
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
  const bytes = new Uint8Array(expected.size_bytes);
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
      bytes.set(chunk.value, offset);
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
  const digest = await window.crypto.subtle.digest("SHA-256", bytes.buffer);
  if (signal?.aborted) throw abortError();
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== expected.sha256) malformed("integrity mismatch");
  return bytes.buffer;
}
