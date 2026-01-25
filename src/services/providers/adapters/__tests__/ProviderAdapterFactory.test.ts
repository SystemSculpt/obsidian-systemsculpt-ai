/**
 * @jest-environment node
 */

// Mock obsidian before imports
jest.mock("obsidian", () => ({
  Platform: { isMobile: false, isDesktop: true, isMobileApp: false },
  requestUrl: jest.fn(),
}));

// Mock adapters
jest.mock("../AnthropicAdapter", () => ({
  AnthropicAdapter: jest.fn().mockImplementation(() => ({
    type: "anthropic",
  })),
}));

jest.mock("../OpenAICompatibleAdapter", () => ({
  OpenAICompatibleAdapter: jest.fn().mockImplementation(() => ({
    type: "openai-compatible",
  })),
}));

jest.mock("../MiniMaxAdapter", () => ({
  MiniMaxAdapter: jest.fn().mockImplementation(() => ({
    type: "minimax",
  })),
}));

jest.mock("../MoonshotAdapter", () => ({
  MoonshotAdapter: jest.fn().mockImplementation(() => ({
    type: "moonshot",
  })),
}));

import { ProviderAdapterFactory } from "../ProviderAdapterFactory";
import { AnthropicAdapter } from "../AnthropicAdapter";
import { OpenAICompatibleAdapter } from "../OpenAICompatibleAdapter";
import { MiniMaxAdapter } from "../MiniMaxAdapter";
import { MoonshotAdapter } from "../MoonshotAdapter";
import { CustomProvider } from "../../../../types";

describe("ProviderAdapterFactory", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createAdapter", () => {
    it("creates AnthropicAdapter for anthropic.com endpoint", () => {
      const provider: CustomProvider = {
        id: "test-1",
        name: "Test Anthropic",
        endpoint: "https://api.anthropic.com",
        apiKey: "sk-test",
        models: [],
      };

      const adapter = ProviderAdapterFactory.createAdapter(provider);

      expect(AnthropicAdapter).toHaveBeenCalledWith(provider, undefined);
      expect(adapter).toEqual({ type: "anthropic" });
    });

    it("creates AnthropicAdapter for claude.ai endpoint", () => {
      const provider: CustomProvider = {
        id: "test-2",
        name: "Test Claude",
        endpoint: "https://claude.ai/api",
        apiKey: "sk-test",
        models: [],
      };

      ProviderAdapterFactory.createAdapter(provider);

      expect(AnthropicAdapter).toHaveBeenCalled();
    });

    it("creates AnthropicAdapter for correctable anthropic endpoint", () => {
      const provider: CustomProvider = {
        id: "test-3",
        name: "Malformed Anthropic",
        endpoint: "https://proxy.example.com/api.anthropic.com/v1",
        apiKey: "sk-test",
        models: [],
      };

      ProviderAdapterFactory.createAdapter(provider);

      expect(AnthropicAdapter).toHaveBeenCalled();
    });

    it("creates MoonshotAdapter for moonshot.ai endpoint", () => {
      const provider: CustomProvider = {
        id: "test-4",
        name: "Moonshot",
        endpoint: "https://api.moonshot.ai/v1",
        apiKey: "sk-test",
        models: [],
      };

      ProviderAdapterFactory.createAdapter(provider);

      expect(MoonshotAdapter).toHaveBeenCalledWith(provider);
    });

    it("creates MoonshotAdapter for moonshot.cn endpoint", () => {
      const provider: CustomProvider = {
        id: "test-5",
        name: "Moonshot CN",
        endpoint: "https://api.moonshot.cn/v1",
        apiKey: "sk-test",
        models: [],
      };

      ProviderAdapterFactory.createAdapter(provider);

      expect(MoonshotAdapter).toHaveBeenCalled();
    });

    it("creates MiniMaxAdapter for minimax endpoint", () => {
      const provider: CustomProvider = {
        id: "test-6",
        name: "MiniMax",
        endpoint: "https://api.minimax.io/v1",
        apiKey: "sk-test",
        models: [],
      };

      ProviderAdapterFactory.createAdapter(provider);

      expect(MiniMaxAdapter).toHaveBeenCalledWith(provider);
    });

    it("creates OpenAICompatibleAdapter for generic endpoint", () => {
      const provider: CustomProvider = {
        id: "test-7",
        name: "OpenAI",
        endpoint: "https://api.openai.com/v1",
        apiKey: "sk-test",
        models: [],
      };

      ProviderAdapterFactory.createAdapter(provider);

      expect(OpenAICompatibleAdapter).toHaveBeenCalledWith(provider);
    });

    it("creates OpenAICompatibleAdapter for custom endpoint", () => {
      const provider: CustomProvider = {
        id: "test-8",
        name: "Custom LLM",
        endpoint: "https://my-llm.example.com/api",
        apiKey: "sk-test",
        models: [],
      };

      ProviderAdapterFactory.createAdapter(provider);

      expect(OpenAICompatibleAdapter).toHaveBeenCalledWith(provider);
    });

    it("passes plugin to AnthropicAdapter", () => {
      const provider: CustomProvider = {
        id: "test-9",
        name: "Anthropic",
        endpoint: "https://api.anthropic.com",
        apiKey: "sk-test",
        models: [],
      };
      const mockPlugin = {} as any;

      ProviderAdapterFactory.createAdapter(provider, mockPlugin);

      expect(AnthropicAdapter).toHaveBeenCalledWith(provider, mockPlugin);
    });
  });

  describe("getProviderType", () => {
    it('returns "anthropic" for anthropic.com endpoints', () => {
      expect(ProviderAdapterFactory.getProviderType("https://api.anthropic.com")).toBe("anthropic");
      expect(ProviderAdapterFactory.getProviderType("https://api.anthropic.com/v1")).toBe("anthropic");
    });

    it('returns "anthropic" for claude.ai endpoints', () => {
      expect(ProviderAdapterFactory.getProviderType("https://claude.ai")).toBe("anthropic");
    });

    it('returns "anthropic" for correctable anthropic endpoints', () => {
      expect(ProviderAdapterFactory.getProviderType("https://proxy.example.com/api.anthropic.com")).toBe("anthropic");
    });

    it('returns "moonshot" for moonshot.ai endpoints', () => {
      expect(ProviderAdapterFactory.getProviderType("https://api.moonshot.ai/v1")).toBe("moonshot");
    });

    it('returns "moonshot" for moonshot.cn endpoints', () => {
      expect(ProviderAdapterFactory.getProviderType("https://api.moonshot.cn")).toBe("moonshot");
    });

    it('returns "minimax" for minimax endpoints', () => {
      expect(ProviderAdapterFactory.getProviderType("https://api.minimax.io/v1")).toBe("minimax");
    });

    it('returns "openai-compatible" for unknown endpoints', () => {
      expect(ProviderAdapterFactory.getProviderType("https://api.openai.com/v1")).toBe("openai-compatible");
      expect(ProviderAdapterFactory.getProviderType("https://my-server.com/api")).toBe("openai-compatible");
      expect(ProviderAdapterFactory.getProviderType("http://localhost:8080")).toBe("openai-compatible");
    });

    it("handles mixed case endpoints", () => {
      expect(ProviderAdapterFactory.getProviderType("https://API.ANTHROPIC.COM")).toBe("anthropic");
      expect(ProviderAdapterFactory.getProviderType("https://API.MOONSHOT.AI/v1")).toBe("moonshot");
      expect(ProviderAdapterFactory.getProviderType("https://API.MINIMAX.IO/v1")).toBe("minimax");
    });
  });
});
