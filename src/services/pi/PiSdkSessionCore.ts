import {
  createAgentSession,
  createCodingTools,
} from "@mariozechner/pi-coding-agent";
import type {
  AgentSession,
  ExtensionRuntime,
  ProviderConfig,
  ResourceLoader,
} from "@mariozechner/pi-coding-agent";

// Keep the heavy Pi session/tooling surface isolated behind a lazy import so model
// registry reads do not pull in bash/TUI code during provider inventory.
export {
  createAgentSession,
  createCodingTools,
};

// Obsidian does not load Pi extensions through this path. The session only needs
// the pre-bind runtime shape that the Pi loader would normally create.
export function createExtensionRuntime(): ExtensionRuntime {
  const notInitialized = () => {
    throw new Error(
      "Extension runtime not initialized. Action methods cannot be called during extension loading.",
    );
  };

  const runtime: ExtensionRuntime = {
    sendMessage: notInitialized,
    sendUserMessage: notInitialized,
    appendEntry: notInitialized,
    setSessionName: notInitialized,
    getSessionName: notInitialized,
    setLabel: notInitialized,
    getActiveTools: notInitialized,
    getAllTools: notInitialized,
    setActiveTools: notInitialized,
    refreshTools: () => {},
    getCommands: notInitialized,
    setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
    getThinkingLevel: notInitialized,
    setThinkingLevel: notInitialized,
    flagValues: new Map(),
    pendingProviderRegistrations: [] as Array<{
      name: string;
      config: ProviderConfig;
      extensionPath: string;
    }>,
    registerProvider: (name: string, config: ProviderConfig, extensionPath = "<unknown>") => {
      runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
    },
    unregisterProvider: (name: string) => {
      runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter(
        (registration) => registration.name !== name,
      );
    },
  };

  return runtime;
}

export type {
  AgentSession,
  ResourceLoader,
};
