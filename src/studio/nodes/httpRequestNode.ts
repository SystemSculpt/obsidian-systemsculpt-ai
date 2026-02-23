import type { StudioJsonValue, StudioNodeDefinition } from "../types";
import { isRecord } from "../utils";
import { getText } from "./shared";

export const httpRequestNode: StudioNodeDefinition = {
  kind: "studio.http_request",
  version: "1.0.0",
  capabilityClass: "local_io",
  cachePolicy: "never",
  inputPorts: [
    { id: "url", type: "text", required: false },
    { id: "body", type: "json", required: false },
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
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const configuredUrl = getText(context.node.config.url as StudioJsonValue).trim();
    const url = getText(context.inputs.url).trim() || configuredUrl;
    if (!url) {
      throw new Error(`HTTP request node "${context.node.id}" requires a URL.`);
    }

    context.services.assertNetworkUrl(url);

    const configuredMethod = getText(context.node.config.method as StudioJsonValue).toUpperCase().trim();
    const method = configuredMethod || "GET";
    const headersRaw = isRecord(context.node.config.headers)
      ? (context.node.config.headers as Record<string, StudioJsonValue>)
      : {};
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(headersRaw)) {
      headers[key] = getText(value);
    }

    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const bodyInput = context.inputs.body;
      if (typeof bodyInput === "string") {
        body = bodyInput;
      } else if (bodyInput != null) {
        body = JSON.stringify(bodyInput);
        if (!headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: context.signal,
    });

    const responseText = await response.text();
    let responseJson: StudioJsonValue = null;
    try {
      responseJson = JSON.parse(responseText) as StudioJsonValue;
    } catch {
      responseJson = null;
    }

    return {
      outputs: {
        status: response.status,
        body: responseText,
        json: responseJson,
      },
    };
  },
};
