import type { StudioJsonValue, StudioNodeDefinition } from "../types";
import { isRecord } from "../utils";
import { getText, renderTemplate, resolveTemplateVariables } from "./shared";

const DEFAULT_MAX_REQUESTS = 500;
const DEFAULT_THROTTLE_MS = 0;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_AUTH_HEADER_NAME = "Authorization";

type HttpRequestMode = "single" | "batch_items";

type HttpRequestResponseSnapshot = {
  status: number;
  bodyText: string;
  bodyJson: StudioJsonValue;
  ok: boolean;
};

type HttpRequestBatchResponseItem = {
  index: number;
  status: number;
  ok: boolean;
  body: string;
  json: StudioJsonValue;
  item: StudioJsonValue;
  url: string;
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

function asMode(value: StudioJsonValue | undefined): HttpRequestMode {
  const normalized = String(value || "single").trim().toLowerCase();
  return normalized === "batch_items" ? "batch_items" : "single";
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

function cloneJsonValue<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function normalizeBatchItems(value: StudioJsonValue | undefined): StudioJsonValue[] {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return [...value];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return normalizeBatchItems(JSON.parse(trimmed) as StudioJsonValue);
      } catch {
        return [trimmed];
      }
    }
    return [trimmed];
  }
  if (!isRecord(value)) {
    return [value];
  }
  const payload = value as Record<string, StudioJsonValue>;
  const candidates = [payload.items, payload.rows, payload.data, payload.emails];
  for (const candidate of candidates) {
    const normalized = normalizeBatchItems(candidate);
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return [payload];
}

function asTemplateVariables(
  context: Parameters<StudioNodeDefinition["execute"]>[0],
  item: StudioJsonValue | null,
  index: number
): Record<string, string> {
  const variables: Record<string, string> = {
    ...resolveTemplateVariables(context),
    index: String(index),
  };
  if (item === null) {
    return variables;
  }
  variables.item = getText(item);
  if (isRecord(item)) {
    for (const [key, value] of Object.entries(item as Record<string, StudioJsonValue>)) {
      const normalizedKey = String(key || "")
        .trim()
        .replace(/[^a-zA-Z0-9_]+/g, "_");
      if (!normalizedKey) {
        continue;
      }
      variables[`item_${normalizedKey}`] = getText(value as StudioJsonValue);
    }
  }
  return variables;
}

function resolveItemValue(item: StudioJsonValue, itemBodyField: string): StudioJsonValue {
  const field = String(itemBodyField || "").trim();
  if (!field) {
    return item;
  }
  if (isRecord(item)) {
    const payload = item as Record<string, StudioJsonValue>;
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      return payload[field];
    }
  }
  return item;
}

function buildRequestBody(options: {
  mode: HttpRequestMode;
  method: string;
  bodyInput: StudioJsonValue | undefined;
  bodyConfig: StudioJsonValue | undefined;
  bodyTemplate: string;
  context: Parameters<StudioNodeDefinition["execute"]>[0];
  item: StudioJsonValue | null;
  itemBodyField: string;
  mergeItemObject: boolean;
  index: number;
}): StudioJsonValue | undefined {
  if (options.method === "GET" || options.method === "HEAD") {
    return undefined;
  }

  const template = options.bodyTemplate.trim();
  if (template) {
    const rendered = renderTemplate(template, asTemplateVariables(options.context, options.item, options.index)).trim();
    if (!rendered) {
      return undefined;
    }
    try {
      return JSON.parse(rendered) as StudioJsonValue;
    } catch {
      return rendered;
    }
  }

  const baseBody =
    typeof options.bodyInput !== "undefined"
      ? cloneJsonValue(options.bodyInput)
      : cloneJsonValue(options.bodyConfig);

  if (options.mode !== "batch_items") {
    return baseBody;
  }

  if (options.item === null) {
    return baseBody;
  }

  const itemValue = resolveItemValue(options.item, options.itemBodyField);
  const itemField = String(options.itemBodyField || "").trim();
  if (itemField) {
    const base =
      isRecord(baseBody) ? { ...(baseBody as Record<string, StudioJsonValue>) } : {};
    base[itemField] = cloneJsonValue(itemValue);
    return base;
  }

  if (isRecord(baseBody) && options.mergeItemObject && isRecord(options.item)) {
    return {
      ...(baseBody as Record<string, StudioJsonValue>),
      ...(options.item as Record<string, StudioJsonValue>),
    };
  }

  if (typeof baseBody !== "undefined") {
    return baseBody;
  }

  return cloneJsonValue(options.item);
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

async function requestWithRetry(options: {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyValue: StudioJsonValue | undefined;
  signal: AbortSignal;
  maxRetries: number;
}): Promise<HttpRequestResponseSnapshot> {
  let attempt = 0;
  while (attempt <= options.maxRetries) {
    if (options.signal.aborted) {
      throw new Error("HTTP request aborted.");
    }
    try {
      const headers = { ...options.headers };
      let body: string | undefined;
      if (typeof options.bodyValue === "string") {
        body = options.bodyValue;
      } else if (typeof options.bodyValue !== "undefined") {
        body = JSON.stringify(options.bodyValue);
        if (!hasHeaderCaseInsensitive(headers, "Content-Type")) {
          headers["Content-Type"] = "application/json";
        }
      }

      const response = await fetch(options.url, {
        method: options.method,
        headers,
        body,
        signal: options.signal,
      });
      const bodyText = await response.text();
      let bodyJson: StudioJsonValue = null;
      try {
        bodyJson = JSON.parse(bodyText) as StudioJsonValue;
      } catch {
        bodyJson = null;
      }

      if (isRetryableStatus(response.status) && attempt < options.maxRetries) {
        const backoffMs = 400 * Math.pow(2, attempt);
        await sleep(backoffMs, options.signal);
        attempt += 1;
        continue;
      }

      return {
        status: response.status,
        bodyText,
        bodyJson,
        ok: response.status >= 200 && response.status < 300,
      };
    } catch (error) {
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

async function resolveAuthHeader(context: Parameters<StudioNodeDefinition["execute"]>[0]): Promise<{
  key: string;
  value: string;
} | null> {
  const source = getText(context.node.config.authSource as StudioJsonValue).trim().toLowerCase();
  if (source === "none" || !source) {
    return null;
  }

  let token = "";
  if (source === "plaintext") {
    token = getText(context.node.config.authToken as StudioJsonValue).trim();
    if (!token) {
      throw new Error(`HTTP request node "${context.node.id}" requires an auth token.`);
    }
  } else if (source === "keychain_ref") {
    const referenceId = getText(context.node.config.authTokenRef as StudioJsonValue).trim();
    if (!referenceId) {
      throw new Error(`HTTP request node "${context.node.id}" requires a keychain auth token reference.`);
    }
    if (!context.services.secretStore.isAvailable()) {
      throw new Error(`HTTP request node "${context.node.id}" cannot resolve keychain secrets in this runtime.`);
    }
    token = await context.services.secretStore.getSecret(referenceId);
    if (!token.trim()) {
      throw new Error(`HTTP request node "${context.node.id}" resolved an empty auth token.`);
    }
  } else {
    throw new Error(
      `HTTP request node "${context.node.id}" has an unsupported auth source "${source}".`
    );
  }

  const headerKey =
    getText(context.node.config.authHeaderName as StudioJsonValue).trim() || DEFAULT_AUTH_HEADER_NAME;
  const scheme = getText(context.node.config.authScheme as StudioJsonValue).trim().toLowerCase();
  const value = scheme === "none" || !scheme ? token : `${scheme === "bearer" ? "Bearer" : scheme} ${token}`;
  return { key: headerKey, value };
}

export const httpRequestNode: StudioNodeDefinition = {
  kind: "studio.http_request",
  version: "1.0.0",
  capabilityClass: "api",
  cachePolicy: "never",
  inputPorts: [
    { id: "url", type: "text", required: false },
    { id: "body", type: "json", required: false },
    { id: "items", type: "json", required: false },
  ],
  outputPorts: [
    { id: "status", type: "number" },
    { id: "body", type: "text" },
    { id: "json", type: "json" },
    { id: "items", type: "json" },
    { id: "succeeded", type: "number" },
    { id: "failed", type: "number" },
    { id: "skipped", type: "number" },
    { id: "total", type: "number" },
    { id: "responses", type: "json" },
    { id: "summary", type: "json" },
  ],
  configDefaults: {
    mode: "single",
    method: "GET",
    url: "",
    headers: {},
    authSource: "none",
    authTokenRef: "",
    authToken: "",
    authHeaderName: DEFAULT_AUTH_HEADER_NAME,
    authScheme: "bearer",
    body: {},
    bodyTemplate: "",
    itemBodyField: "",
    mergeItemObject: true,
    maxRequests: DEFAULT_MAX_REQUESTS,
    throttleMs: DEFAULT_THROTTLE_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
    dryRun: false,
    continueOnHttpError: true,
  },
  configSchema: {
    fields: [
      {
        key: "mode",
        label: "Mode",
        type: "select",
        required: true,
        selectPresentation: "button_group",
        options: [
          { value: "single", label: "Single Request" },
          { value: "batch_items", label: "Batch Items" },
        ],
      },
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
        key: "authSource",
        label: "Auth Source",
        type: "select",
        required: true,
        selectPresentation: "button_group",
        options: [
          { value: "none", label: "None" },
          { value: "keychain_ref", label: "Keychain Ref" },
          { value: "plaintext", label: "Plaintext" },
        ],
      },
      {
        key: "authTokenRef",
        label: "Keychain Auth Token Ref",
        description: "Studio keychain reference ID for the auth token.",
        type: "text",
        required: true,
        placeholder: "resend.marketing",
        visibleWhen: {
          key: "authSource",
          equals: "keychain_ref",
        },
      },
      {
        key: "authToken",
        label: "Auth Token",
        description: "Fallback plaintext token. Prefer keychain references for production.",
        type: "text",
        required: true,
        placeholder: "token_xxxxx",
        visibleWhen: {
          key: "authSource",
          equals: "plaintext",
        },
      },
      {
        key: "authHeaderName",
        label: "Auth Header Name",
        type: "text",
        required: true,
        placeholder: DEFAULT_AUTH_HEADER_NAME,
        visibleWhen: {
          key: "authSource",
          equals: ["keychain_ref", "plaintext"],
        },
      },
      {
        key: "authScheme",
        label: "Auth Scheme",
        type: "select",
        required: true,
        options: [
          { value: "bearer", label: "Bearer" },
          { value: "none", label: "None" },
        ],
        visibleWhen: {
          key: "authSource",
          equals: ["keychain_ref", "plaintext"],
        },
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
        key: "body",
        label: "Default Body",
        description: "Used when no body input is provided.",
        type: "json_object",
        required: false,
      },
      {
        key: "bodyTemplate",
        label: "Body Template",
        description: "Optional raw template body. Supports {{inputPort}} variables and {{item}} in batch mode.",
        type: "textarea",
        required: false,
        placeholder: "{\"email\":\"{{item}}\"}",
      },
      {
        key: "itemBodyField",
        label: "Item Body Field",
        description: "When set in batch mode, each item is assigned to this field in the request body.",
        type: "text",
        required: false,
        placeholder: "email",
        visibleWhen: {
          key: "mode",
          equals: "batch_items",
        },
      },
      {
        key: "mergeItemObject",
        label: "Merge Item Object Into Body",
        type: "boolean",
        required: true,
        visibleWhen: {
          key: "mode",
          equals: "batch_items",
        },
      },
      {
        key: "maxRequests",
        label: "Max Requests",
        type: "number",
        required: true,
        min: 1,
        max: 5000,
        integer: true,
        visibleWhen: {
          key: "mode",
          equals: "batch_items",
        },
      },
      {
        key: "throttleMs",
        label: "Throttle (ms)",
        type: "number",
        required: true,
        min: 0,
        max: 60000,
        integer: true,
        visibleWhen: {
          key: "mode",
          equals: "batch_items",
        },
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
      {
        key: "dryRun",
        label: "Dry Run",
        description: "Build request payloads without sending network calls.",
        type: "boolean",
        required: true,
      },
      {
        key: "continueOnHttpError",
        label: "Continue On HTTP Error",
        description: "When disabled, any non-2xx response fails the node immediately.",
        type: "boolean",
        required: true,
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
    const mode = asMode(context.node.config.mode as StudioJsonValue);
    const method = normalizeMethod(context.node.config.method as StudioJsonValue);
    const headers = readHeaders(context.node.config.headers as StudioJsonValue);
    const authHeader = await resolveAuthHeader(context);
    if (authHeader) {
      headers[authHeader.key] = authHeader.value;
    }
    const maxRetries = readFiniteInt(context.node.config.maxRetries as StudioJsonValue, DEFAULT_MAX_RETRIES, {
      min: 0,
      max: 8,
    });
    const dryRun = context.node.config.dryRun === true;
    const continueOnHttpError = context.node.config.continueOnHttpError !== false;

    if (mode === "single") {
      const variables = asTemplateVariables(context, null, 0);
      const url = renderTemplate(baseUrlTemplate, variables).trim();
      if (!url) {
        throw new Error(`HTTP request node "${context.node.id}" resolved an empty URL.`);
      }
      context.services.assertNetworkUrl(url);
      const bodyValue = buildRequestBody({
        mode,
        method,
        bodyInput: context.inputs.body,
        bodyConfig: context.node.config.body as StudioJsonValue,
        bodyTemplate: getText(context.node.config.bodyTemplate as StudioJsonValue),
        context,
        item: null,
        itemBodyField: "",
        mergeItemObject: context.node.config.mergeItemObject !== false,
        index: 0,
      });

      if (dryRun) {
        return {
          outputs: {
            status: 0,
            body: "",
            json: null,
            items: [],
            succeeded: 0,
            failed: 0,
            skipped: 0,
            total: 1,
            responses: [
              {
                index: 0,
                status: 0,
                ok: true,
                body: "",
                json: null,
                item: null,
                url,
              } as HttpRequestBatchResponseItem,
            ],
            summary: {
              mode,
              dryRun: true,
              total: 1,
              succeeded: 0,
              failed: 0,
              skipped: 0,
            },
          },
        };
      }

      const response = await requestWithRetry({
        url,
        method,
        headers,
        bodyValue,
        signal: context.signal,
        maxRetries,
      });
      if (!response.ok && !continueOnHttpError) {
        throw new Error(summarizeHttpError(response.status, response.bodyText));
      }
      return {
        outputs: {
          status: response.status,
          body: response.bodyText,
          json: response.bodyJson,
          items: [],
          succeeded: response.ok ? 1 : 0,
          failed: response.ok ? 0 : 1,
          skipped: 0,
          total: 1,
          responses: [
            {
              index: 0,
              status: response.status,
              ok: response.ok,
              body: response.bodyText,
              json: response.bodyJson,
              item: null,
              url,
            } as HttpRequestBatchResponseItem,
          ],
          summary: {
            mode,
            dryRun: false,
            total: 1,
            succeeded: response.ok ? 1 : 0,
            failed: response.ok ? 0 : 1,
            skipped: 0,
          },
        },
      };
    }

    const rawItems =
      typeof context.inputs.items !== "undefined"
        ? context.inputs.items
        : Array.isArray(context.inputs.body)
          ? context.inputs.body
          : undefined;
    const normalizedItems = normalizeBatchItems(rawItems);
    const maxRequests = readFiniteInt(context.node.config.maxRequests as StudioJsonValue, DEFAULT_MAX_REQUESTS, {
      min: 1,
      max: 5000,
    });
    const throttleMs = readFiniteInt(context.node.config.throttleMs as StudioJsonValue, DEFAULT_THROTTLE_MS, {
      min: 0,
      max: 60000,
    });
    const itemBodyField = getText(context.node.config.itemBodyField as StudioJsonValue).trim();
    const mergeItemObject = context.node.config.mergeItemObject !== false;
    const items = normalizedItems.slice(0, maxRequests);
    const skipped = Math.max(0, normalizedItems.length - items.length);

    if (items.length === 0) {
      return {
        outputs: {
          status: 0,
          body: "",
          json: null,
          items: [],
          succeeded: 0,
          failed: 0,
          skipped,
          total: 0,
          responses: [],
          summary: {
            mode,
            dryRun,
            total: 0,
            succeeded: 0,
            failed: 0,
            skipped,
          },
        },
      };
    }

    const responses: HttpRequestBatchResponseItem[] = [];
    let succeeded = 0;
    let failed = 0;
    for (let index = 0; index < items.length; index += 1) {
      if (context.signal.aborted) {
        throw new Error(`HTTP request node "${context.node.id}" aborted.`);
      }
      const item = items[index];
      const variables = asTemplateVariables(context, item, index);
      const url = renderTemplate(baseUrlTemplate, variables).trim();
      if (!url) {
        throw new Error(`HTTP request node "${context.node.id}" resolved an empty URL for batch item ${index}.`);
      }
      context.services.assertNetworkUrl(url);

      const bodyValue = buildRequestBody({
        mode,
        method,
        bodyInput: context.inputs.body,
        bodyConfig: context.node.config.body as StudioJsonValue,
        bodyTemplate: getText(context.node.config.bodyTemplate as StudioJsonValue),
        context,
        item,
        itemBodyField,
        mergeItemObject,
        index,
      });

      if (dryRun) {
        responses.push({
          index,
          status: 0,
          ok: true,
          body: "",
          json: null,
          item,
          url,
        });
      } else {
        const response = await requestWithRetry({
          url,
          method,
          headers,
          bodyValue,
          signal: context.signal,
          maxRetries,
        });
        responses.push({
          index,
          status: response.status,
          ok: response.ok,
          body: response.bodyText,
          json: response.bodyJson,
          item,
          url,
        });
        if (response.ok) {
          succeeded += 1;
        } else {
          failed += 1;
          if (!continueOnHttpError) {
            throw new Error(summarizeHttpError(response.status, response.bodyText));
          }
        }
      }

      if (index < items.length - 1 && throttleMs > 0) {
        await sleep(throttleMs, context.signal);
      }
    }

    const last = responses[responses.length - 1];
    return {
      outputs: {
        status: last?.status ?? 0,
        body: last?.body ?? "",
        json: typeof last?.json === "undefined" ? null : last.json,
        items,
        succeeded,
        failed,
        skipped,
        total: items.length,
        responses,
        summary: {
          mode,
          dryRun,
          total: items.length,
          succeeded,
          failed,
          skipped,
        },
      },
    };
  },
};
