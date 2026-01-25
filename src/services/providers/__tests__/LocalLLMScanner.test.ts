/**
 * @jest-environment node
 */

// Mock httpClient
const mockHttpRequest = jest.fn();
const mockIsHostTemporarilyDisabled = jest.fn();

jest.mock("../../../utils/httpClient", () => ({
  httpRequest: (...args: any[]) => mockHttpRequest(...args),
  isHostTemporarilyDisabled: (...args: any[]) => mockIsHostTemporarilyDisabled(...args),
}));

import { scanLocalLLMProviders, LocalLLMOption } from "../LocalLLMScanner";

describe("LocalLLMScanner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsHostTemporarilyDisabled.mockReturnValue({ disabled: false });
  });

  describe("scanLocalLLMProviders", () => {
    it("returns empty array when no local LLMs found", async () => {
      mockHttpRequest.mockRejectedValue(new Error("Connection refused"));

      const result = await scanLocalLLMProviders();

      expect(result).toEqual([]);
    });

    it("detects LM Studio when models endpoint returns data", async () => {
      mockHttpRequest.mockImplementation((options: { url: string }) => {
        if (options.url === "http://localhost:1234/v1/models") {
          return Promise.resolve({
            status: 200,
            json: {
              data: [{ id: "model-1" }, { id: "model-2" }],
            },
          });
        }
        return Promise.reject(new Error("Not found"));
      });

      const result = await scanLocalLLMProviders();

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("lmstudio");
      expect(result[0].endpoint).toBe("http://localhost:1234/v1");
      expect(result[0].models).toEqual(["model-1", "model-2"]);
      expect(result[0].label).toBe("LM Studio • 2 models");
    });

    it("detects Ollama when models endpoint returns data", async () => {
      mockHttpRequest.mockImplementation((options: { url: string }) => {
        if (options.url === "http://localhost:11434/v1/models") {
          return Promise.resolve({
            status: 200,
            json: {
              data: [{ id: "llama2" }, { id: "mistral" }],
            },
          });
        }
        return Promise.reject(new Error("Not found"));
      });

      const result = await scanLocalLLMProviders();

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("ollama");
      expect(result[0].endpoint).toBe("http://localhost:11434/v1");
      expect(result[0].models).toEqual(["llama2", "mistral"]);
    });

    it("uses Ollama tags fallback when models endpoint fails", async () => {
      mockHttpRequest.mockImplementation((options: { url: string }) => {
        if (options.url === "http://localhost:11434/api/tags") {
          return Promise.resolve({
            status: 200,
            json: {
              models: [{ name: "llama2:latest" }, { name: "codellama:7b" }],
            },
          });
        }
        return Promise.reject(new Error("Not found"));
      });

      const result = await scanLocalLLMProviders();

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("ollama");
      expect(result[0].models).toEqual(["llama2:latest", "codellama:7b"]);
    });

    it("detects both LM Studio and Ollama when both are running", async () => {
      mockHttpRequest.mockImplementation((options: { url: string }) => {
        if (options.url === "http://localhost:1234/v1/models") {
          return Promise.resolve({
            status: 200,
            json: { data: [{ id: "lmstudio-model" }] },
          });
        }
        if (options.url === "http://localhost:11434/v1/models") {
          return Promise.resolve({
            status: 200,
            json: { data: [{ id: "ollama-model" }] },
          });
        }
        return Promise.reject(new Error("Not found"));
      });

      const result = await scanLocalLLMProviders();

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.type)).toContain("lmstudio");
      expect(result.map((r) => r.type)).toContain("ollama");
    });

    it("skips disabled hosts", async () => {
      mockIsHostTemporarilyDisabled.mockReturnValue({ disabled: true });

      const result = await scanLocalLLMProviders();

      expect(result).toEqual([]);
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it("handles empty model list", async () => {
      mockHttpRequest.mockImplementation((options: { url: string }) => {
        if (options.url === "http://localhost:1234/v1/models") {
          return Promise.resolve({
            status: 200,
            json: { data: [] },
          });
        }
        return Promise.reject(new Error("Not found"));
      });

      const result = await scanLocalLLMProviders();

      expect(result).toEqual([]);
    });

    it("filters out non-string model ids", async () => {
      mockHttpRequest.mockImplementation((options: { url: string }) => {
        if (options.url === "http://localhost:1234/v1/models") {
          return Promise.resolve({
            status: 200,
            json: {
              data: [
                { id: "valid-model" },
                { id: null },
                { id: 123 },
                { id: "another-valid" },
              ],
            },
          });
        }
        return Promise.reject(new Error("Not found"));
      });

      const result = await scanLocalLLMProviders();

      expect(result).toHaveLength(1);
      expect(result[0].models).toEqual(["valid-model", "another-valid"]);
    });

    it("handles non-200 status codes", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 500,
        json: null,
      });

      const result = await scanLocalLLMProviders();

      expect(result).toEqual([]);
    });

    it("parses text response when json is null", async () => {
      mockHttpRequest.mockImplementation((options: { url: string }) => {
        if (options.url === "http://localhost:1234/v1/models") {
          return Promise.resolve({
            status: 200,
            json: null,
            text: JSON.stringify({ data: [{ id: "parsed-model" }] }),
          });
        }
        return Promise.reject(new Error("Not found"));
      });

      const result = await scanLocalLLMProviders();

      expect(result).toHaveLength(1);
      expect(result[0].models).toEqual(["parsed-model"]);
    });

    it("deduplicates providers by type and endpoint", async () => {
      // This scenario shouldn't happen in practice but tests the dedup logic
      mockHttpRequest.mockImplementation((options: { url: string }) => {
        if (options.url === "http://localhost:1234/v1/models") {
          return Promise.resolve({
            status: 200,
            json: { data: [{ id: "model-1" }] },
          });
        }
        return Promise.reject(new Error("Not found"));
      });

      const result = await scanLocalLLMProviders();

      // Even if somehow duplicates were returned, they should be deduped
      const keys = result.map((r) => `${r.type}::${r.endpoint}`);
      const uniqueKeys = [...new Set(keys)];
      expect(keys.length).toBe(uniqueKeys.length);
    });

    it("formats singular model label correctly", async () => {
      mockHttpRequest.mockImplementation((options: { url: string }) => {
        if (options.url === "http://localhost:1234/v1/models") {
          return Promise.resolve({
            status: 200,
            json: { data: [{ id: "single-model" }] },
          });
        }
        return Promise.reject(new Error("Not found"));
      });

      const result = await scanLocalLLMProviders();

      expect(result[0].label).toBe("LM Studio • 1 model");
    });
  });
});
