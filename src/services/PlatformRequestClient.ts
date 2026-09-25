import { requestUrl } from "obsidian";
import { postJsonStreaming } from "../utils/streaming";
import { toError } from "../utils/errors";

export type PlatformTransport = "fetch" | "requestUrl";

// Obsidian requestUrl is the canonical cross-device transport. Direct fetch is
// reserved for incremental SSE, where requestUrl can only return a buffered
// response.
function preferredTransport(stream: boolean): PlatformTransport {
  return stream && typeof window.fetch === "function" ? "fetch" : "requestUrl";
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
   * Client deadline in milliseconds. When it passes, the request rejects with
   * PlatformRequestTimeoutError. Non-streaming requests default to
   * PLATFORM_REQUEST_TIMEOUT_MS, extended for the declared transfer size (see
   * platformTransferTimeoutMs); raw uploads never get less than two minutes.
   * The deadline covers a non-streaming response body too; over direct fetch
   * that body is read before the request resolves. A streaming deadline
   * covers only the response headers. Streaming requests have no default
   * deadline. `null` disables it.
   */
  timeoutMs?: number | null;
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

/** Default deadline for an ordinary JSON exchange. */
export const PLATFORM_REQUEST_TIMEOUT_MS = 30_000;
/** Slowest sustained link a transfer deadline still admits (512 kbit/s). */
const MIN_TRANSFER_BYTES_PER_SECOND = 64 * 1024;
const RAW_UPLOAD_TIMEOUT_FLOOR_MS = 2 * 60_000;

/**
 * Deadline that admits `bytes` of request and response payload at the
 * slowest supported link, on top of the ordinary exchange allowance.
 */
export function platformTransferTimeoutMs(bytes: number): number {
  return PLATFORM_REQUEST_TIMEOUT_MS
    + Math.ceil((Math.max(0, bytes) * 1_000) / MIN_TRANSFER_BYTES_PER_SECOND);
}

/**
 * The client stopped waiting at its deadline. The server may still have
 * received and processed the request, exactly as after a dropped connection.
 */
export class PlatformRequestTimeoutError extends Error {
  readonly name = "TimeoutError";
  readonly code = "request_timeout";
  readonly retryable = true;

  constructor(public readonly timeoutMs: number) {
    super(`The request did not finish within ${Math.ceil(timeoutMs / 1_000)} seconds.`);
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

type Deadline = Readonly<{ at: number; timeoutMs: number }>;

/** Statuses whose response carries no body, not even an empty buffered one. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Reads a direct fetch response's body now, so the request deadline covers
 * it, and returns an equivalent response over the buffered bytes.
 */
async function bufferedResponse(response: Response): Promise<Response> {
  const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Returns `response` with a body that calls `release` once it has been read
 * to the end, has failed, or was cancelled.
 */
function releaseAfterBody(response: Response, release: () => void): Response {
  const source = response.body;
  if (!source) {
    release();
    return response;
  }
  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function defaultTimeoutMs(input: PlatformRequestInput, body: ArrayBuffer | string | undefined): number | null {
  // A stream stays open for a whole turn; its caller owns cancellation, and
  // the transport choice before it has its own bounded probe.
  if (input.stream) return null;
  const bodyBytes = body === undefined
    ? 0
    : typeof body === "string" ? body.length : body.byteLength;
  const transfer = platformTransferTimeoutMs(bodyBytes + (input.maxResponseBytes ?? 0));
  return input.bodyEncoding === "raw"
    ? Math.max(RAW_UPLOAD_TIMEOUT_FLOOR_MS, transfer)
    : transfer;
}

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
    if (
      input.timeoutMs !== undefined
      && input.timeoutMs !== null
      && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1)
    ) {
      throw new TypeError("Request timeout must be a positive integer or null.");
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
    const timeoutMs = input.timeoutMs === undefined
      ? defaultTimeoutMs(input, body)
      : input.timeoutMs;
    // One deadline spans every transport attempt of this request.
    const deadline: Deadline | null = timeoutMs === null
      ? null
      : { at: Date.now() + timeoutMs, timeoutMs };

    if (input.stream && !input.preserveResponseHeaders) {
      this.observeTransport(input, transport);
      const send = (signal?: AbortSignal) => postJsonStreaming(
        input.url,
        headers,
        input.body,
        transport !== "fetch",
        signal,
      );
      const response = deadline === null
        ? await send(input.signal)
        : await this.fetchWithin(input.signal, deadline, true, send);
      return markResponseDeliveryMode(
        response,
        transport === "fetch" ? "fetch_stream" : "request_url_buffered",
      );
    }

    if (transport === "fetch" && typeof window.fetch === "function") {
      let responded = false;
      try {
        const send = async (signal?: AbortSignal) => {
          const response = await window.fetch(input.url, {
            method: input.method,
            headers,
            body,
            cache: input.cache ?? "no-store",
            signal,
          });
          responded = true;
          return response;
        };
        const response = deadline === null
          ? await send(input.signal)
          : await this.fetchWithin(input.signal, deadline, input.stream === true, send);
        this.observeTransport(input, "fetch");
        return input.stream
          ? markResponseDeliveryMode(response, "fetch_stream")
          : response;
      } catch (error) {
        if (error instanceof PlatformRequestTimeoutError) throw error;
        if (input.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          throw error;
        }
        // A body that failed after the server answered is never replayed.
        if (responded || directLoopbackFetch || input.allowTransportFallback === false) throw error;
      }
    }
    if (directLoopbackFetch) {
      throw new TypeError("Direct loopback fetch is unavailable.");
    }

    if (input.signal?.aborted) {
      throw abortError();
    }

    this.observeTransport(input, "requestUrl");
    // requestUrl takes no signal: on abort or deadline the client only stops
    // waiting, and the host finishes or fails the detached request itself.
    const result = await this.within(input.signal, deadline, () => requestUrl({
      url: input.url,
      method: input.method,
      headers,
      body,
      throw: false,
    }));

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

  /**
   * Runs a direct fetch under the deadline with a signal linked to the
   * caller's. A non-streaming body is read before the deadline lapses. The
   * link is removed once the request has settled (for a stream, once its body
   * has been consumed), so a long-lived caller signal never accumulates
   * finished requests.
   */
  private async fetchWithin(
    signal: AbortSignal | undefined,
    deadline: Deadline,
    stream: boolean,
    send: (signal: AbortSignal) => Promise<Response>,
  ): Promise<Response> {
    const controller = new AbortController();
    const forward = (): void => controller.abort();
    const unlink = (): void => signal?.removeEventListener("abort", forward);
    signal?.addEventListener("abort", forward, { once: true });
    let response: Response;
    try {
      response = await this.within(
        signal,
        deadline,
        async () => {
          const received = await send(controller.signal);
          return stream ? received : await bufferedResponse(received);
        },
        () => controller.abort(),
      );
    } catch (error) {
      unlink();
      throw error;
    }
    if (!stream) {
      unlink();
      return response;
    }
    return releaseAfterBody(response, unlink);
  }

  /**
   * Settles one transport attempt at the first of its own result, the
   * caller's abort, or the deadline. `onDeadline` stops the attempt's network
   * work when the deadline passes; a requestUrl attempt has none to stop.
   */
  private within<T>(
    signal: AbortSignal | undefined,
    deadline: Deadline | null,
    attempt: () => Promise<T>,
    onDeadline?: () => void,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (!deadline && !signal) return attempt();
    const remainingMs = deadline ? deadline.at - Date.now() : 0;
    if (deadline && remainingMs <= 0) {
      return Promise.reject(new PlatformRequestTimeoutError(deadline.timeoutMs));
    }
    return new Promise<T>((resolve, reject) => {
      let timer: number | undefined;
      const settle = (): void => {
        if (timer !== undefined) window.clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
      };
      const aborted = (): void => {
        settle();
        reject(abortError());
      };
      signal?.addEventListener("abort", aborted, { once: true });
      if (deadline) {
        timer = window.setTimeout(() => {
          settle();
          // Reject first so the attempt's own abort rejection is ignored.
          reject(new PlatformRequestTimeoutError(deadline.timeoutMs));
          onDeadline?.();
        }, remainingMs);
      }
      let pending: Promise<T>;
      try {
        pending = Promise.resolve(attempt());
      } catch (error) {
        settle();
        reject(toError(error, "The request failed."));
        return;
      }
      pending.then(
        (value) => {
          settle();
          resolve(value);
        },
        (error: unknown) => {
          settle();
          reject(toError(error, "The request failed."));
        },
      );
    });
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
    if (typeof window.fetch !== "function") return false;
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
      const response = await window.fetch(url, {
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
          reject(toError(error, "Streaming transport probe failed."));
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
