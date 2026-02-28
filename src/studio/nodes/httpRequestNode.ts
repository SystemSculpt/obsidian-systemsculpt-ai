import type { StudioJsonValue, StudioNodeDefinition } from "../types";
import { isRecord } from "../utils";
import { PlatformContext } from "../../services/PlatformContext";
import { getText, renderTemplate, resolveTemplateVariables } from "./shared";
import { requestUrl } from "obsidian";

const DEFAULT_MAX_RETRIES = 2;

type HttpRequestResponseSnapshot = {
  status: number;
  bodyText: string;
  bodyJson: StudioJsonValue;
  ok: boolean;
};

type HttpRequestBodyMode = "auto" | "json" | "text";
type ResolvedHttpRequestBodyMode = "json" | "text";

type PreparedHttpRequestBody = {
  body: string | undefined;
  resolvedMode: ResolvedHttpRequestBodyMode | null;
};

function readFiniteInt(
  value: StudioJsonValue | undefined,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const rounded = Math.floor(parsed);
  return Math.max(bounds.min, Math.min(bounds.max, rounded));
}

function hasHeaderCaseInsensitive(headers: Record<string, string>, key: string): boolean {
  const normalized = String(key || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return Object.keys(headers).some((candidate) => candidate.trim().toLowerCase() === normalized);
}

function normalizeMethod(value: StudioJsonValue | undefined): string {
  const method = String(value || "GET").trim().toUpperCase();
  if (!method) {
    return "GET";
  }
  return method;
}

function readHeaders(value: StudioJsonValue | undefined): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, StudioJsonValue>)) {
    const headerKey = String(key || "").trim();
    if (!headerKey) {
      continue;
    }
    out[headerKey] = getText(entry);
  }
  return out;
}

function formatBearerAuthorization(token: string): string {
  const trimmed = String(token || "").trim();
  if (!trimmed) {
    return "";
  }
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed;
  }
  return `Bearer ${trimmed}`;
}

function summarizeHttpError(status: number, bodyText: string): string {
  const snippet = String(bodyText || "").trim().slice(0, 240);
  if (!snippet) {
    return `HTTP request failed (${status}).`;
  }
  return `HTTP request failed (${status}): ${snippet}`;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("HTTP request aborted."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("HTTP request aborted."));
    };
    signal.addEventListener("abort", onAbort);
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function normalizeBodyMode(value: StudioJsonValue | undefined): HttpRequestBodyMode {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "json" || normalized === "text" || normalized === "auto") {
    return normalized;
  }
  return "auto";
}

function coerceBodyToText(value: StudioJsonValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return JSON.stringify(value);
}

function prepareHttpRequestBody(options: {
  bodyValue: StudioJsonValue | undefined;
  bodyMode: HttpRequestBodyMode;
}): PreparedHttpRequestBody {
  if (typeof options.bodyValue === "undefined") {
    return {
      body: undefined,
      resolvedMode: null,
    };
  }

  if (options.bodyMode === "text") {
    return {
      body: coerceBodyToText(options.bodyValue),
      resolvedMode: "text",
    };
  }

  if (options.bodyMode === "json") {
    if (typeof options.bodyValue === "string") {
      const trimmed = options.bodyValue.trim();
      if (!trimmed) {
        throw new Error("HTTP request body mode is JSON, but body text is empty.");
      }
      try {
        const parsed = JSON.parse(trimmed) as StudioJsonValue;
        return {
          body: JSON.stringify(parsed),
          resolvedMode: "json",
        };
      } catch {
        throw new Error("HTTP request body mode is JSON, but body text is not valid JSON.");
      }
    }

    return {
      body: JSON.stringify(options.bodyValue),
      resolvedMode: "json",
    };
  }

  if (typeof options.bodyValue === "string") {
    return {
      body: options.bodyValue,
      resolvedMode: "text",
    };
  }

  return {
    body: JSON.stringify(options.bodyValue),
    resolvedMode: "json",
  };
}

function shouldUseRequestUrlForEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === "api.resend.com" || host.endsWith(".api.resend.com");
  } catch {
    return false;
  }
}

async function requestWithRetry(options: {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyValue: StudioJsonValue | undefined;
  bodyMode: HttpRequestBodyMode;
  signal: AbortSignal;
  maxRetries: number;
}): Promise<HttpRequestResponseSnapshot> {
  const preferredTransport = PlatformContext.get().preferredTransport({ endpoint: options.url });
  let useRequestUrl = preferredTransport === "requestUrl" || shouldUseRequestUrlForEndpoint(options.url);

  const preparedBody = prepareHttpRequestBody({
    bodyValue: options.bodyValue,
    bodyMode: options.bodyMode,
  });
  const body = preparedBody.body;

  const headers = { ...options.headers };
  if (typeof body !== "undefined" && !hasHeaderCaseInsensitive(headers, "Content-Type")) {
    headers["Content-Type"] =
      preparedBody.resolvedMode === "text" ? "text/plain; charset=utf-8" : "application/json";
  }

  let attempt = 0;
  while (attempt <= options.maxRetries) {
    if (options.signal.aborted) {
      throw new Error("HTTP request aborted.");
    }

    try {
      let responseText = "";
      let status = 0;

      if (useRequestUrl) {
        const response = await requestUrl({
          url: options.url,
          method: options.method,
          headers,
          body,
          throw: false,
        });

        status = response.status ?? 0;
        if (typeof response.text === "string") {
          responseText = response.text;
        } else if (typeof response.json !== "undefined") {
          responseText = JSON.stringify(response.json);
        }
      } else {
        const response = await fetch(options.url, {
          method: options.method,
          headers,
          body,
          signal: options.signal,
        });

        status = response.status;
        responseText = await response.text();
      }

      let bodyJson: StudioJsonValue = null;
      try {
        bodyJson = responseText ? (JSON.parse(responseText) as StudioJsonValue) : null;
      } catch {
        bodyJson = null;
      }

      if (status >= 400 && (isRetryableStatus(status) || status === 0) && attempt < options.maxRetries) {
        const backoffMs = 400 * Math.pow(2, attempt);
        await sleep(backoffMs, options.signal);
        attempt += 1;
        continue;
      }

      return {
        status,
        bodyText: responseText,
        bodyJson,
        ok: status >= 200 && status < 300,
      };
    } catch (error) {
      if (!useRequestUrl && preferredTransport !== "requestUrl") {
        useRequestUrl = true;
        continue;
      }
      if (attempt >= options.maxRetries) {
        throw error;
      }
      const backoffMs = 400 * Math.pow(2, attempt);
      await sleep(backoffMs, options.signal);
      attempt += 1;
    }
  }

  throw new Error("HTTP request failed after retries.");
}

export const httpRequestNode: StudioNodeDefinition = {
  kind: "studio.http_request",
  version: "1.0.0",
  capabilityClass: "api",
  cachePolicy: "never",
  inputPorts: [
    { id: "url", type: "text", required: false },
    { id: "body", type: "any", required: false },
  ],
  outputPorts: [
    { id: "status", type: "number" },
    { id: "body", type: "text" },
    { id: "json", type: "json" },
  ],
  configDefaults: {
    method: "GET",
    url: "",
    headers: {},
    bearerToken: "",
    bodyMode: "auto",
    body: {},
    maxRetries: DEFAULT_MAX_RETRIES,
  },
  configSchema: {
    fields: [
      {
        key: "method",
        label: "Method",
        type: "select",
        required: true,
        options: [
          { value: "GET", label: "GET" },
          { value: "POST", label: "POST" },
          { value: "PUT", label: "PUT" },
          { value: "PATCH", label: "PATCH" },
          { value: "DELETE", label: "DELETE" },
          { value: "HEAD", label: "HEAD" },
        ],
      },
      {
        key: "url",
        label: "URL",
        type: "text",
        required: false,
        placeholder: "Can be provided by input port instead.",
      },
      {
        key: "headers",
        label: "Headers",
        type: "json_object",
        required: false,
      },
      {
        key: "bearerToken",
        label: "Bearer Token",
        description: "Optional token for Authorization header.",
        type: "text",
        inputType: "password",
        required: false,
        placeholder: "re_xxxxx",
      },
      {
        key: "bodyMode",
        label: "Body Mode",
        description: "Auto chooses text/plain for string input and JSON for structured input.",
        type: "select",
        required: true,
        options: [
          { value: "auto", label: "Auto" },
          { value: "json", label: "JSON" },
          { value: "text", label: "Text" },
        ],
      },
      {
        key: "body",
        label: "Default Body",
        description: "Used when no body input is provided.",
        type: "json_object",
        required: false,
      },
      {
        key: "maxRetries",
        label: "Max Retries",
        type: "number",
        required: true,
        min: 0,
        max: 8,
        integer: true,
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const configuredUrl = getText(context.node.config.url as StudioJsonValue).trim();
    const inputUrl = getText(context.inputs.url).trim();
    const baseUrlTemplate = inputUrl || configuredUrl;
    if (!baseUrlTemplate) {
      throw new Error(`HTTP request node "${context.node.id}" requires a URL.`);
    }

    const method = normalizeMethod(context.node.config.method as StudioJsonValue);
    const headers = readHeaders(context.node.config.headers as StudioJsonValue);
    const bearerToken = getText(context.node.config.bearerToken as StudioJsonValue).trim();
    if (bearerToken && !hasHeaderCaseInsensitive(headers, "Authorization")) {
      headers.Authorization = formatBearerAuthorization(bearerToken);
    }
    const maxRetries = readFiniteInt(context.node.config.maxRetries as StudioJsonValue, DEFAULT_MAX_RETRIES, {
      min: 0,
      max: 8,
    });
    const bodyMode = normalizeBodyMode(context.node.config.bodyMode as StudioJsonValue);

    const variables = resolveTemplateVariables(context);
    const url = renderTemplate(baseUrlTemplate, variables).trim();
    if (!url) {
      throw new Error(`HTTP request node "${context.node.id}" resolved an empty URL.`);
    }
    context.services.assertNetworkUrl(url);

    const bodyValue =
      method === "GET" || method === "HEAD"
        ? undefined
        : typeof context.inputs.body !== "undefined"
          ? context.inputs.body
          : (context.node.config.body as StudioJsonValue);

    const response = await requestWithRetry({
      url,
      method,
      headers,
      bodyValue,
      bodyMode,
      signal: context.signal,
      maxRetries,
    });

    if (!response.ok) {
      throw new Error(summarizeHttpError(response.status, response.bodyText));
    }

    return {
      outputs: {
        status: response.status,
        body: response.bodyText,
        json: response.bodyJson,
      },
    };
  },
};
