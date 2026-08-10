import { requestUrl } from "obsidian";
import { postJsonStreaming } from "../utils/streaming";

export type PlatformTransport = "fetch" | "requestUrl";

// Obsidian requestUrl is the canonical cross-device transport. Direct fetch is
// reserved for incremental SSE, where requestUrl can only return a buffered
// response.
function preferredTransport(stream: boolean): PlatformTransport {
  return stream && typeof fetch === "function" ? "fetch" : "requestUrl";
}

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
  maxResponseBytes?: number;
  /**
   * Replay-safe endpoint used to prove that direct browser fetch can read the
   * first-party origin before a state-changing streaming request is sent.
   */
  streamingProbeUrl?: string;
  /** Observational only; callback failures are contained by the transport. */
  onTransportSelected?: (transport: PlatformTransport) => void;
};

export type PlatformResponseDeliveryMode =
  | "fetch_stream"
  | "request_url_buffered";

/**
 * Obsidian's native request gateway may attempt TLS for a loopback HTTP URL.
 * Direct fetch is both the browser-native transport and the only correct local
 * development path for these exact loopback origins.
 */
export function isSafeLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === "127.0.0.1"
      || hostname === "localhost"
      || hostname === "[::1]";
  } catch {
    return false;
  }
}

const RESPONSE_DELIVERY_MODE = new WeakMap<Response, PlatformResponseDeliveryMode>();

/** Client-owned transport metadata; unlike an HTTP header, the server cannot spoof it. */
export function getPlatformResponseDeliveryMode(
  response: Response,
): PlatformResponseDeliveryMode | undefined {
  return RESPONSE_DELIVERY_MODE.get(response);
}

function markResponseDeliveryMode(
  response: Response,
  mode: PlatformResponseDeliveryMode,
): Response {
  RESPONSE_DELIVERY_MODE.set(response, mode);
  return response;
}

type StreamingProbeResult = Readonly<{
  directFetch: boolean;
  expiresAt: number;
}>;

const STREAMING_PROBE_TIMEOUT_MS = 3_000;
const STREAMING_PROBE_SUCCESS_TTL_MS = 5 * 60_000;
const STREAMING_PROBE_FAILURE_TTL_MS = 30_000;

export class PlatformRequestClient {
  private readonly streamingProbeResults = new Map<string, StreamingProbeResult>();
  private readonly streamingProbeRequests = new Map<string, Promise<boolean>>();

  /**
   * Warms the replay-safe streaming transport decision before a user command.
   * The ordinary request path still performs the same bounded probe whenever
   * this prewarm was unavailable or its cached result has expired.
   */
  public async prewarmStreamingFetch(url: string): Promise<boolean> {
    if (preferredTransport(true) !== "fetch") return false;
    return this.probeStreamingFetch(url);
  }

  public async request(input: PlatformRequestInput): Promise<Response> {
    const rawBody = input.bodyEncoding === "raw";
    if (rawBody && input.body !== undefined && !(input.body instanceof ArrayBuffer)) {
      throw new TypeError("Raw platform request bodies must be an ArrayBuffer.");
    }
    if (
      input.maxResponseBytes !== undefined
      && (!Number.isInteger(input.maxResponseBytes) || input.maxResponseBytes < 1)
    ) {
      throw new TypeError("Maximum platform response size must be a positive integer.");
    }
    const directLoopbackFetch = input.transport === undefined
      && isSafeLoopbackHttpUrl(input.url);
    let transport = input.transport
      ?? (directLoopbackFetch
        ? "fetch"
        : preferredTransport(input.stream === true));
    if (transport === "fetch" && input.stream && input.streamingProbeUrl) {
      const directFetch = await this.probeStreamingFetch(input.streamingProbeUrl, input.signal);
      if (!directFetch) transport = "requestUrl";
    }
    const headers: Record<string, string> = rawBody
      ? this.rawRequestHeaders(input.headers, input.body as ArrayBuffer | undefined)
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
      this.observeTransport(input, transport);
      const response = await postJsonStreaming(
        input.url,
        headers,
        input.body,
        transport !== "fetch",
        input.signal,
      );
      return markResponseDeliveryMode(
        response,
        transport === "fetch" ? "fetch_stream" : "request_url_buffered",
      );
    }

    if (transport === "fetch" && typeof fetch === "function") {
      try {
        const response = await fetch(input.url, {
          method: input.method,
          headers,
          body,
          cache: input.cache ?? "no-store",
          signal: input.signal,
        } as RequestInit);
        this.observeTransport(input, "fetch");
        return input.stream
          ? markResponseDeliveryMode(response, "fetch_stream")
          : response;
      } catch (error) {
        if (input.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          throw error;
        }
        if (directLoopbackFetch || input.allowTransportFallback === false) throw error;
      }
    }
    if (directLoopbackFetch) {
      throw new TypeError("Direct loopback fetch is unavailable.");
    }

    if (input.signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }

    this.observeTransport(input, "requestUrl");
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
    if (
      input.maxResponseBytes !== undefined
      && input.responseEncoding === "arrayBuffer"
      && result.arrayBuffer.byteLength > input.maxResponseBytes
    ) {
      throw new TypeError("Native response exceeded the configured maximum size.");
    }
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

    const response = new Response(responseBody, { status, headers: responseHeaders });
    return input.stream
      ? markResponseDeliveryMode(response, "request_url_buffered")
      : response;
  }

  private observeTransport(
    input: PlatformRequestInput,
    transport: PlatformTransport,
  ): void {
    try {
      input.onTransportSelected?.(transport);
    } catch {
      // Diagnostics must never alter request delivery.
    }
  }

  private rawRequestHeaders(
    inputHeaders: Record<string, string> | undefined,
    body: ArrayBuffer | undefined,
  ): Record<string, string> {
    const headers = { ...(inputHeaders || {}) };
    const contentLengthNames = Object.keys(headers).filter(
      (name) => name.toLowerCase() === "content-length",
    );
    if (contentLengthNames.length > 1) {
      throw new TypeError("Raw platform requests cannot contain duplicate Content-Length headers.");
    }
    const contentLengthName = contentLengthNames[0];
    if (!contentLengthName) return headers;

    const declaredLength = headers[contentLengthName];
    if (
      !body
      || !/^(0|[1-9]\d*)$/.test(declaredLength)
      || Number(declaredLength) !== body.byteLength
    ) {
      throw new TypeError("Raw platform request Content-Length must match the ArrayBuffer size.");
    }

    // Chromium and Electron own this restricted header. Supplying it through
    // Obsidian requestUrl fails before the request reaches the signed object
    // store; omitting it still sends the exact byte length from the body.
    delete headers[contentLengthName];
    return headers;
  }

  private async probeStreamingFetch(url: string, signal?: AbortSignal): Promise<boolean> {
    if (typeof fetch !== "function") return false;
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");

    const cacheKey = this.streamingProbeCacheKey(url);
    const cached = this.streamingProbeResults.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.directFetch;

    let request = this.streamingProbeRequests.get(cacheKey);
    if (!request) {
      request = this.performStreamingProbe(url, cacheKey);
      this.streamingProbeRequests.set(cacheKey, request);
      void request.then(
        () => {
          if (this.streamingProbeRequests.get(cacheKey) === request) {
            this.streamingProbeRequests.delete(cacheKey);
          }
        },
        () => {
          if (this.streamingProbeRequests.get(cacheKey) === request) {
            this.streamingProbeRequests.delete(cacheKey);
          }
        },
      );
    }
    return this.awaitStreamingProbe(request, signal);
  }

  private async performStreamingProbe(
    url: string,
    cacheKey: string,
  ): Promise<boolean> {
    const controller = new AbortController();
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
    } catch {
      this.streamingProbeResults.set(cacheKey, {
        directFetch: false,
        expiresAt: Date.now() + STREAMING_PROBE_FAILURE_TTL_MS,
      });
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private async awaitStreamingProbe(
    request: Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!signal) return request;
    if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    return new Promise<boolean>((resolve, reject) => {
      const aborted = (): void => {
        signal.removeEventListener("abort", aborted);
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      signal.addEventListener("abort", aborted, { once: true });
      void request.then(
        (value) => {
          signal.removeEventListener("abort", aborted);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", aborted);
          reject(error);
        },
      );
    });
  }

  private streamingProbeCacheKey(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }
}
