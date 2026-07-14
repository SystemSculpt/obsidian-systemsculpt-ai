import { requestUrl } from "obsidian";

/**
 * Open a managed JSON/SSE response. Fetch is used only when the host can keep
 * SSE incremental; Obsidian requestUrl is the cross-device buffered fallback.
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
    return await fetch(url, {
      method: "POST",
      headers,
      body: json,
      signal,
    });
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
