import * as Obsidian from 'obsidian';

export interface HttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponseShim {
  status: number;
  json?: any;
  text?: string;
  headers?: Record<string, string>;
}

// Simple per-host circuit breaker to avoid hammering unreachable hosts
// failures: consecutive networkish failures count
// disabledUntil: epoch ms when we will attempt again
const hostState = new Map<string, { failures: number; disabledUntil?: number }>();
const USER_AGENT = 'SystemSculpt-Obsidian';

function getHost(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

function isLocalHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '0.0.0.0'
      || hostname === '::1'
      || hostname === 'host.docker.internal';
  } catch {
    return false;
  }
}

function normalizeHeaders(method: string, headers?: Record<string,string>, body?: string): Record<string,string> {
  const out: Record<string,string> = { ...(headers || {}) };
  const m = (method || 'GET').toUpperCase();
  if (m === 'GET') {
    for (const k of Object.keys(out)) {
      if (k.toLowerCase() === 'content-type') delete out[k];
    }
  } else if (body && !Object.keys(out).some(k => k.toLowerCase() === 'content-type')) {
    out['Content-Type'] = 'application/json';
  }
  if (!Object.keys(out).some(k => k.toLowerCase() === 'user-agent')) {
    out['User-Agent'] = USER_AGENT;
  }
  return out;
}

export async function httpRequest(opts: HttpRequestOptions): Promise<HttpResponseShim> {
  const method = opts.method || 'GET';
  const headers = normalizeHeaders(method, opts.headers, opts.body);
  const host = getHost(opts.url);
  const localHost = isLocalHost(opts.url);
  const now = Date.now();
  const state = hostState.get(host);
  const disabled = !!(state?.disabledUntil && state.disabledUntil > now);
  const timeoutMs = Math.max(0, Number(opts.timeoutMs || 0));

  // Generic timeout wrapper that races the underlying request
  async function withTimeout<T>(promise: Promise<T>): Promise<T> {
    if (!timeoutMs) return promise;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Request timed out'));
      }, timeoutMs);

      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  async function requestLocalViaNode(): Promise<{ status: number; text: string; headers: Record<string, string> }> {
    const url = new URL(opts.url);
    const isHttps = url.protocol === "https:";
    const httpLib = require("http") as typeof import("http");
    const httpsLib = require("https") as typeof import("https");
    const lib = isHttps ? httpsLib : httpLib;

    return await new Promise((resolve, reject) => {
      const req = lib.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port ? Number(url.port) : undefined,
          method,
          path: `${url.pathname}${url.search}`,
          headers,
        },
        (res) => {
          const chunks: Array<Buffer> = [];
          res.on("data", (chunk) => {
            if (Buffer.isBuffer(chunk)) {
              chunks.push(chunk);
            } else {
              chunks.push(Buffer.from(chunk));
            }
          });
          res.on("end", () => {
            clearTimer();
            const text = Buffer.concat(chunks).toString("utf8");
            const headersOut: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === "string") {
                headersOut[key] = value;
              } else if (Array.isArray(value)) {
                headersOut[key] = value.join(", ");
              }
            }
            resolve({ status: res.statusCode ?? 0, text, headers: headersOut });
          });
        }
      );

      const timer = timeoutMs ? setTimeout(() => req.destroy(new Error("Request timed out")), timeoutMs) : null;
      const clearTimer = () => {
        if (timer) clearTimeout(timer);
      };

      req.on("error", (error) => {
        clearTimer();
        reject(error);
      });
      req.on("close", clearTimer);

      if (opts.body) {
        req.write(opts.body);
      }
      req.end();
    });
  }

  // If host is temporarily disabled due to repeated failures, short‑circuit
  if (disabled) {
    const waitMs = (state!.disabledUntil || 0) - now;
    const mins = Math.max(1, Math.round(waitMs / 60000));
    const message = `Host temporarily unavailable (circuit open). Retry in ~${mins} min.`;
    try {
      const { errorLogger } = await import('./errorLogger');
      errorLogger.debug('HTTP circuit open; skipping request', { source: 'httpClient', method: 'httpRequest', metadata: { host, retryInMs: waitMs } });
    } catch {}
    const shortError: any = new Error(message);
    shortError.status = 0;
    shortError.retryInMs = waitMs;
    throw shortError;
  }

  try {
    const r = localHost
      ? await requestLocalViaNode()
      : await withTimeout(Obsidian.requestUrl({ url: opts.url, method, headers, body: opts.body, throw: false }));

    const status = r.status || 0;
    const text = (r as any).text as string | undefined;
    let parsed: any = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch {}
    if (!status || status >= 400) {
      const hdrs = ((r as any).headers || {}) as Record<string, string>;
      throw { status: status || 500, text, json: parsed, headers: hdrs, message: text || (parsed && (parsed.error?.message || parsed.message)) || `HTTP ${status}` };
    }
    const hdrs = ((r as any).headers || {}) as Record<string, string>;
    // Success resets circuit breaker for this host
    if (host) hostState.set(host, { failures: 0, disabledUntil: undefined });
    return { status, text, json: parsed, headers: hdrs } as HttpResponseShim;
  } catch (err: any) {
    const msg = String(err?.message || '');
    const status = typeof err?.status === 'number' ? err.status : undefined;
    const responseText = typeof err?.text === 'string' ? err.text : '';
    const looksHtml = responseText.trim().startsWith('<');
    const isGatewayish = status === 502 || status === 503 || status === 504;
    const isHtmlForbidden = status === 403 && looksHtml;
    const isServerDegraded = isGatewayish || (!!status && status >= 500 && looksHtml);
    const isNetworkish = msg.includes('net::ERR') || msg.includes('ENOTFOUND') || msg.includes('ECONN') || msg.includes('ECONNRESET') || msg.includes('REFUSED');
    // NOTE: 403 HTML is often payload/WAF-specific. Do not treat it as a connectivity failure.
    const shouldBackoff = isNetworkish || isServerDegraded;
    // Update state only for connectivity failures; reset on non-connectivity errors.
    if (host) {
      const nextState = hostState.get(host) || { failures: 0, disabledUntil: undefined };
      if (shouldBackoff) {
        nextState.failures += 1;
        const backoffMinutes = nextState.failures <= 1
          ? 0
          : Math.min(60, 2 * Math.pow(2, Math.min(5, nextState.failures - 2)));
        if (backoffMinutes > 0) {
          nextState.disabledUntil = Date.now() + backoffMinutes * 60 * 1000;
        }
      } else {
        nextState.failures = 0;
        nextState.disabledUntil = undefined;
      }
      hostState.set(host, nextState);
      try {
        const { errorLogger } = await import('./errorLogger');
        const metadata = { host, failures: nextState.failures, disabledUntil: nextState.disabledUntil, status, message: msg, htmlForbidden: isHtmlForbidden };
        if (shouldBackoff) {
          errorLogger.warn('HTTP gateway error; circuit update', { source: 'httpClient', method: 'httpRequest', metadata });
        } else if (isHtmlForbidden) {
          errorLogger.debug('HTTP 403 HTML forbidden; ignoring for circuit', { source: 'httpClient', method: 'httpRequest', metadata });
        } else {
          errorLogger.debug('HTTP error; circuit reset', { source: 'httpClient', method: 'httpRequest', metadata });
        }
      } catch {}
    }
    throw err;
  }
}

/**
 * Returns true if the host for the given URL is temporarily disabled
 * due to repeated network failures. Useful to avoid even attempting requests.
 */
export function isHostTemporarilyDisabled(url: string): { disabled: boolean; retryInMs: number } {
  const host = getHost(url);
  if (!host) return { disabled: false, retryInMs: 0 };
  const s = hostState.get(host);
  const now = Date.now();
  if (s?.disabledUntil && s.disabledUntil > now) {
    return { disabled: true, retryInMs: s.disabledUntil - now };
  }
  return { disabled: false, retryInMs: 0 };
}
