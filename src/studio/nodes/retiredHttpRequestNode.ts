import type { StudioNodeDefinition } from "../types";

export const retiredHttpRequestNode: StudioNodeDefinition = {
  kind: "studio.retired_http_request",
  version: "1.0.0",
  requiredHostCapabilities: [],
  hiddenFromInsertMenu: true,
  capabilityClass: "local_cpu",
  cachePolicy: "never",
  inputPorts: [
    { id: "url", type: "text", required: false },
    { id: "headers", type: "json", required: false },
    { id: "query", type: "json", required: false },
    { id: "path_params", type: "json", required: false },
    { id: "bearer_token", type: "text", required: false },
    { id: "body_json", type: "json", required: false },
    { id: "body_text", type: "text", required: false },
  ],
  outputPorts: [
    { id: "status", type: "number" },
    { id: "body", type: "text" },
    { id: "json", type: "json" },
  ],
  configDefaults: {
    reason: "HTTP Request nodes are retired. Replace this node with a retained managed capability.",
  },
  configSchema: {
    fields: [],
    allowUnknownKeys: false,
  },
  async execute() {
    throw new Error("HTTP Request nodes are retired and cannot execute.");
  },
};
