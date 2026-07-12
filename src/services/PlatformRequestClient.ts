import { requestUrl } from "obsidian";
import { PlatformContext } from "./PlatformContext";
import { postJsonStreaming } from "../utils/streaming";

export type PlatformRequestInput = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  stream?: boolean;
  signal?: AbortSignal;
  cache?: RequestCache;
  licenseKey?: string;
  preserveResponseHeaders?: boolean;
  allowTransportFallback?: boolean;
};

export class PlatformRequestClient {
  public async request(input: PlatformRequestInput): Promise<Response> {
    const platform = PlatformContext.get();
    const transport = platform.preferredTransport({ endpoint: input.url });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: input.stream ? "text/event-stream" : "application/json",
      ...(input.licenseKey ? { "x-license-key": input.licenseKey } : {}),
      ...(input.headers || {}),
    };
    const body = typeof input.body === "undefined" ? undefined : JSON.stringify(input.body);

    if (input.stream && !input.preserveResponseHeaders) {
      return await postJsonStreaming(
        input.url,
        headers,
        input.body,
        transport !== "fetch",
        input.signal,
      );
    }

    if (transport === "fetch" && typeof fetch === "function") {
      try {
        return await fetch(input.url, {
          method: input.method,
          headers,
          body,
          cache: input.cache ?? "no-store",
          signal: input.signal,
        } as RequestInit);
      } catch (error) {
        if (input.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          throw error;
        }
        if (input.allowTransportFallback === false) throw error;
      }
    }

    if (input.signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    const requestPromise = requestUrl({
      url: input.url,
      method: input.method,
      headers,
      body,
      throw: false,
    });
    const result = input.signal
      ? await new Promise<Awaited<typeof requestPromise>>((resolve, reject) => {
          const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
          input.signal!.addEventListener("abort", abort, { once: true });
          requestPromise.then(resolve, reject).finally(() => input.signal!.removeEventListener("abort", abort));
        })
      : await requestPromise;

    const status = result.status || 500;
    const textBody =
      typeof result.text === "string" ? result.text : JSON.stringify(result.json || {});
    const responseHeaders = new Headers();
    const nativeHeaders = (result as typeof result & { headers?: Record<string, string> }).headers;
    if (nativeHeaders) {
      for (const [name, value] of Object.entries(nativeHeaders)) {
        if (typeof value === "string") responseHeaders.set(name, value);
      }
    }
    if (!responseHeaders.has("Content-Type")) {
      responseHeaders.set("Content-Type", input.stream ? "text/event-stream" : "application/json");
    }

    return new Response(textBody, { status, headers: responseHeaders });
  }
}
