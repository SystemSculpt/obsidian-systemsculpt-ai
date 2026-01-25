/**
 * @jest-environment jsdom
 */

import { ChatView } from "../ChatView";

const supportsWebSearch = (overrides: Partial<ChatView> & { plugin: any }) => {
  const base = {
    currentModelSupportsWebSearch: null,
    currentModelSupportedParameters: [],
    plugin: {
      settings: {
        activeProvider: { type: "native", id: "systemsculpt" },
        customProviders: [],
      },
    },
  } as any;

  return ChatView.prototype.supportsWebSearch.call({ ...base, ...overrides });
};

describe("ChatView.supportsWebSearch", () => {
  it("returns true when model capabilities explicitly include web_search", () => {
    const result = supportsWebSearch({
      currentModelSupportsWebSearch: true,
      plugin: {
        settings: {
          activeProvider: { type: "custom", id: "local" },
          customProviders: [{ id: "local", endpoint: "https://example.com" }],
        },
      },
    });

    expect(result).toBe(true);
  });

  it("falls back to native provider when metadata lacks web search", () => {
    const result = supportsWebSearch({
      currentModelSupportsWebSearch: false,
      currentModelSupportedParameters: ["tools"],
      plugin: {
        settings: {
          activeProvider: { type: "native", id: "systemsculpt" },
          customProviders: [],
        },
      },
    });

    expect(result).toBe(true);
  });

  it("allows explicit supported_parameters to enable web search", () => {
    const result = supportsWebSearch({
      currentModelSupportsWebSearch: false,
      currentModelSupportedParameters: ["plugins", "tools"],
      plugin: {
        settings: {
          activeProvider: { type: "custom", id: "custom" },
          customProviders: [{ id: "custom", endpoint: "https://api.example.com" }],
        },
      },
    });

    expect(result).toBe(true);
  });

  it("falls back to openrouter when metadata lacks web search", () => {
    const result = supportsWebSearch({
      currentModelSupportsWebSearch: false,
      currentModelSupportedParameters: ["tools"],
      plugin: {
        settings: {
          activeProvider: { type: "custom", id: "openrouter" },
          customProviders: [{ id: "openrouter", endpoint: "https://openrouter.ai/api/v1" }],
        },
      },
    });

    expect(result).toBe(true);
  });

  it("returns false for non-openrouter custom providers without explicit support", () => {
    const result = supportsWebSearch({
      currentModelSupportsWebSearch: false,
      currentModelSupportedParameters: ["tools"],
      plugin: {
        settings: {
          activeProvider: { type: "custom", id: "custom" },
          customProviders: [{ id: "custom", endpoint: "https://api.example.com" }],
        },
      },
    });

    expect(result).toBe(false);
  });
});
