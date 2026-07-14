import { requestUrl } from "obsidian";
import { PlatformContext, type PlatformTransport } from "./PlatformContext";
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
  transport?: PlatformTransport;
  bodyEncoding?: "json" | "raw";
  responseEncoding?: "text" | "arrayBuffer";
  /**
   * Replay-safe endpoint used to prove that direct browser fetch can read the
   * first-party origin before a state-changing streaming request is sent.
   */
  streamingProbeUrl?: string;
};

type StreamingProbeResult = Readonly<{
  directFetch: boolean;
  expiresAt: number;
}>;

const STREAMING_PROBE_TIMEOUT_MS = 3_000;
const STREAMING_PROBE_SUCCESS_TTL_MS = 5 * 60_000;
const STREAMING_PROBE_FAILURE_TTL_MS = 30_000;

export class PlatformRequestClient {
  private readonly streamingProbeResults = new Map<string, StreamingProbeResult>();

  public async request(input: PlatformRequestInput): Promise<Response> {
    const rawBody = input.bodyEncoding === "raw";
    if (rawBody && input.body !== undefined && !(input.body instanceof ArrayBuffer)) {
      throw new TypeError("Raw platform request bodies must be an ArrayBuffer.");
    }
    let transport = input.transport
      ?? PlatformContext.get().preferredTransport({
        endpoint: input.url,
        stream: input.stream === true,
      });
    if (transport === "fetch" && input.stream && input.streamingProbeUrl) {
      const directFetch = await this.probeStreamingFetch(input.streamingProbeUrl, input.signal);
      if (!directFetch) transport = "requestUrl";
    }
    const headers: Record<string, string> = rawBody
      ? { ...(input.headers || {}) }
      : {
          "Content-Type": "application/json",
          Accept: input.stream ? "text/event-stream" : "application/json",
          ...(input.licenseKey ? { "x-license-key": input.licenseKey } : {}),
          ...(input.headers || {}),
        };
    const body = typeof input.body === "undefined"
      ? undefined
      : rawBody
        ? input.body as ArrayBuffer
        : JSON.stringify(input.body);

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
    const responseBody = input.responseEncoding === "arrayBuffer"
      ? result.arrayBuffer
      : typeof result.text === "string"
        ? result.text
        : JSON.stringify(result.json || {});
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

    return new Response(responseBody, { status, headers: responseHeaders });
  }

  private async probeStreamingFetch(url: string, signal?: AbortSignal): Promise<boolean> {
    if (typeof fetch !== "function") return false;
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");

    const cacheKey = this.streamingProbeCacheKey(url);
    const cached = this.streamingProbeResults.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.directFetch;

    const controller = new AbortController();
    const abortForCaller = () => controller.abort();
    signal?.addEventListener("abort", abortForCaller, { once: true });
    const timeout = window.setTimeout(() => controller.abort(), STREAMING_PROBE_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      void response.body?.cancel().catch(() => undefined);
      this.streamingProbeResults.set(cacheKey, {
        directFetch: true,
        expiresAt: Date.now() + STREAMING_PROBE_SUCCESS_TTL_MS,
      });
      return true;
    } catch (error) {
      if (signal?.aborted) {
        throw error instanceof Error
          ? error
          : new DOMException("The operation was aborted", "AbortError");
      }
      this.streamingProbeResults.set(cacheKey, {
        directFetch: false,
        expiresAt: Date.now() + STREAMING_PROBE_FAILURE_TTL_MS,
      });
      return false;
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abortForCaller);
    }
  }

  private streamingProbeCacheKey(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }
}
