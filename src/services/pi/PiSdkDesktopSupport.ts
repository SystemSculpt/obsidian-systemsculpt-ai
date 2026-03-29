import type SystemSculptPlugin from "../../main";
import {
  createBundledPiAuthStorage,
  type PiAuthStorageInstance,
} from "./PiSdkAuthStorage";
import { resolvePiAuthPath } from "./PiSdkStoragePaths";

type FetchLike = typeof globalThis.fetch;

type PiDesktopFetchRestore = () => void;

function isStandardHeaders(value: unknown): value is Headers {
  return typeof Headers !== "undefined" && value instanceof Headers;
}

function normalizeFetchHeaders(value: unknown): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }

  if (isStandardHeaders(value)) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([key, headerValue]) => [
        String(key),
        String(headerValue),
      ]),
    );
  }

  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .map((entry) => [String(entry?.[0] || ""), String(entry?.[1] || "")])
        .filter(([key]) => key.length > 0),
    );
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, headerValue]) => [
        String(key),
        String(headerValue),
      ]),
    );
  }

  return undefined;
}

function toStandardHeaders(value: unknown): Headers | undefined {
  if (isStandardHeaders(value)) {
    return value;
  }

  const normalized = normalizeFetchHeaders(value);
  if (!normalized || typeof Headers === "undefined") {
    return undefined;
  }

  const headers = new Headers();
  for (const [key, headerValue] of Object.entries(normalized)) {
    headers.set(String(key), String(headerValue));
  }
  return headers;
}

function normalizeFetchResponse<T>(response: T): T {
  if (!response || typeof response !== "object") {
    return response;
  }

  const currentHeaders = (response as { headers?: unknown }).headers;
  const headers = toStandardHeaders(currentHeaders);
  if (!headers || headers === currentHeaders) {
    return response;
  }

  const descriptors = Object.getOwnPropertyDescriptors(response);
  const patchedResponse = Object.create(Object.getPrototypeOf(response));
  Object.defineProperties(patchedResponse, descriptors);
  Object.defineProperty(patchedResponse, "headers", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: headers,
  });

  const clone = (response as { clone?: () => unknown }).clone;
  if (typeof clone === "function") {
    Object.defineProperty(patchedResponse, "clone", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: () => normalizeFetchResponse(clone.call(response)),
    });
  }

  return patchedResponse;
}

async function normalizeFetchBody(
  input: unknown,
  init: RequestInit | undefined,
): Promise<BodyInit | undefined> {
  if (init && Object.prototype.hasOwnProperty.call(init, "body")) {
    return init.body ?? undefined;
  }

  if (!input || typeof input !== "object") {
    return undefined;
  }

  const requestLike = input as Request & { clone?: () => Request };
  const method = String(requestLike.method || "GET").trim().toUpperCase();
  if (method === "GET" || method === "HEAD" || typeof requestLike.clone !== "function") {
    return undefined;
  }

  try {
    return await requestLike.clone().text();
  } catch {
    return undefined;
  }
}

export function installPiDesktopFetchShim(): PiDesktopFetchRestore {
  const runtimeRequire = typeof require === "function" ? require : (globalThis as any).require;
  if (typeof runtimeRequire !== "function") {
    return () => {};
  }

  let sessionFetch: FetchLike | null = null;
  try {
    const electron = runtimeRequire("electron");
    const webContents = electron?.remote?.getCurrentWebContents?.();
    const rawSessionFetch = webContents?.session?.fetch;
    if (typeof rawSessionFetch === "function") {
      sessionFetch = rawSessionFetch.bind(webContents.session) as FetchLike;
    }
  } catch {
    sessionFetch = null;
  }

  if (!sessionFetch) {
    return () => {};
  }

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestLike =
      typeof Request !== "undefined" && input instanceof Request ? input : null;
    const url = requestLike
      ? String(requestLike.url || "")
      : input instanceof URL
        ? input.toString()
        : String(input || "");
    const method =
      String(init?.method || requestLike?.method || "GET").trim() || "GET";
    const headers = normalizeFetchHeaders(init?.headers || requestLike?.headers);
    const body = await normalizeFetchBody(requestLike, init);

    const nextInit: RequestInit = {
      ...(init || {}),
      method,
    };
    if (headers) {
      nextInit.headers = headers;
    }
    if (body !== undefined) {
      nextInit.body = body;
    }

    const response = await sessionFetch!(url, nextInit);
    return normalizeFetchResponse(response);
  }) as FetchLike;

  return () => {
    globalThis.fetch = previousFetch;
  };
}

export async function withPiDesktopFetchShim<T>(
  callback: () => Promise<T> | T,
): Promise<T> {
  const restore = installPiDesktopFetchShim();
  try {
    return await callback();
  } finally {
    restore();
  }
}

export function createPiAuthStorage(options: {
  plugin?: SystemSculptPlugin | null;
} = {}): PiAuthStorageInstance {
  const authPath = resolvePiAuthPath(options.plugin);
  return authPath
    ? createBundledPiAuthStorage(authPath)
    : createBundledPiAuthStorage();
}
