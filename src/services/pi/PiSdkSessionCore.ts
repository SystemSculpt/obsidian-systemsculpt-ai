import {
  createAgentSession,
  createCodingTools,
} from "../../../node_modules/@mariozechner/pi-coding-agent/dist/core/sdk.js";
import { createExtensionRuntime } from "../../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js";

import type { AgentSession, ResourceLoader } from "@mariozechner/pi-coding-agent";

// Keep the heavy Pi session/tooling surface isolated behind a lazy import so model
// registry reads do not pull in bash/TUI code during provider inventory.
export {
  createAgentSession,
  createCodingTools,
  createExtensionRuntime,
};

export type {
  AgentSession,
  ResourceLoader,
};
