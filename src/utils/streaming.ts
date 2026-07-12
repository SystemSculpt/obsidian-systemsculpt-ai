import { requestUrl } from "obsidian";

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError" ||
    error instanceof Error && error.name === "AbortError";
}

/**
 * Open a managed JSON/SSE response. Desktop fetch is preferred so SSE remains
 * incremental; Obsidian requestUrl is a same-host buffered fallback.
 */
export async function postJsonStreaming(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  useBufferedFallback: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  const json = JSON.stringify(body);
  if (!useBufferedFallback && typeof fetch === "function") {
    try {
      return await fetch(url, {
        method: "POST",
        headers,
        body: json,
        signal,
      });
    } catch (error) {
      if (signal?.aborted || isAbort(error)) throw error;
    }
  }

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const result = await requestUrl({
    url,
    method: "POST",
    headers,
    body: json,
    throw: false,
  });
  const text = typeof result.text === "string"
    ? result.text
    : JSON.stringify(result.json ?? {});
  const contentType = String(
    (result as typeof result & { headers?: Record<string, string> }).headers?.["content-type"] ||
    (text.includes("data:") ? "text/event-stream" : "application/json"),
  );
  return new Response(text, {
    status: result.status || 500,
    headers: { "Content-Type": contentType },
  });
}
