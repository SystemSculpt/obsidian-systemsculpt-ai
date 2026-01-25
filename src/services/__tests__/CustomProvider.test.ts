jest.mock("../../utils/httpClient", () => ({
  httpRequest: jest.fn(),
}));

const { httpRequest } = require("../../utils/httpClient") as {
  httpRequest: jest.Mock;
};

import { CustomProvider } from "../embeddings/providers/CustomProvider";

describe("CustomProvider", () => {
  beforeEach(() => {
    httpRequest.mockReset();
  });

  describe("configuration validation", () => {
    it("throws when endpoint URL is empty", async () => {
      const provider = new CustomProvider({
        endpoint: "",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      await expect(provider.generateEmbeddings(["hello"])).rejects.toThrow(
        "Custom endpoint URL is required"
      );
      expect(httpRequest).not.toHaveBeenCalled();
    });

    it("throws when endpoint URL is whitespace only", async () => {
      const provider = new CustomProvider({
        endpoint: "   ",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      await expect(provider.generateEmbeddings(["hello"])).rejects.toThrow(
        "Custom endpoint URL is required"
      );
    });

    it("throws when model is empty", async () => {
      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "",
      });

      await expect(provider.generateEmbeddings(["hello"])).rejects.toThrow(
        "Custom embeddings model is required"
      );
    });

    it("throws when model is whitespace only", async () => {
      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "   ",
      });

      await expect(provider.generateEmbeddings(["hello"])).rejects.toThrow(
        "Custom embeddings model is required"
      );
    });

    it("returns empty array for empty texts input", async () => {
      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      const result = await provider.generateEmbeddings([]);
      expect(result).toEqual([]);
      expect(httpRequest).not.toHaveBeenCalled();
    });
  });

  describe("OpenAI-compatible batch requests", () => {
    it("sends batch request with correct payload structure", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          data: [
            { index: 0, embedding: [0.1, 0.2, 0.3] },
          ],
        }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      await provider.generateEmbeddings(["hello world"]);

      expect(httpRequest).toHaveBeenCalledTimes(1);
      const call = httpRequest.mock.calls[0][0];
      expect(call.url).toBe("http://localhost:1234/v1/embeddings");
      expect(call.method).toBe("POST");

      const body = JSON.parse(call.body);
      expect(body.input).toEqual(["hello world"]);
      expect(body.model).toBe("text-embedding-3-small");
      expect(body.encoding_format).toBe("float");
    });

    it("includes Authorization header when apiKey is provided", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "sk-test-key-123",
        model: "text-embedding-3-small",
      });

      await provider.generateEmbeddings(["hello"]);

      const call = httpRequest.mock.calls[0][0];
      expect(call.headers.Authorization).toBe("Bearer sk-test-key-123");
    });

    it("omits Authorization header when apiKey is empty", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      await provider.generateEmbeddings(["hello"]);

      const call = httpRequest.mock.calls[0][0];
      expect(call.headers.Authorization).toBeUndefined();
    });

    it("handles OpenAI-style data array response", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          data: [
            { index: 0, embedding: [0.1, 0.2, 0.3] },
            { index: 1, embedding: [0.4, 0.5, 0.6] },
          ],
        }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      const result = await provider.generateEmbeddings(["hello", "world"]);

      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);
    });

    it("handles direct array response format", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify([
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ]),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      const result = await provider.generateEmbeddings(["hello", "world"]);

      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);
    });

    it("sorts embeddings by index from response", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          data: [
            { index: 2, embedding: [0.7, 0.8, 0.9] },
            { index: 0, embedding: [0.1, 0.2, 0.3] },
            { index: 1, embedding: [0.4, 0.5, 0.6] },
          ],
        }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      const result = await provider.generateEmbeddings(["a", "b", "c"]);

      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
        [0.7, 0.8, 0.9],
      ]);
    });

    it("sets expectedDimension from first embedding", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4, 0.5] }],
        }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      expect(provider.expectedDimension).toBeUndefined();
      await provider.generateEmbeddings(["hello"]);
      expect(provider.expectedDimension).toBe(5);
    });

    it("throws on unsupported response format", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ unexpected: "format" }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      await expect(provider.generateEmbeddings(["hello"])).rejects.toThrow(
        "Unsupported response format from custom endpoint"
      );
    });
  });

  describe("input_type mapping", () => {
    it("sends input_type='query' when inputType option is 'query'", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      await provider.generateEmbeddings(["search query"], { inputType: "query" });

      const body = JSON.parse(httpRequest.mock.calls[0][0].body);
      expect(body.input_type).toBe("query");
    });

    it("sends input_type='document' by default", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      await provider.generateEmbeddings(["document content"]);

      const body = JSON.parse(httpRequest.mock.calls[0][0].body);
      expect(body.input_type).toBe("document");
    });

    it("sends input_type='document' when inputType is 'document'", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      await provider.generateEmbeddings(["document content"], { inputType: "document" });

      const body = JSON.parse(httpRequest.mock.calls[0][0].body);
      expect(body.input_type).toBe("document");
    });
  });

  describe("batch splitting", () => {
    it("splits batches when texts exceed maxBatchSize", async () => {
      httpRequest.mockImplementation(({ body }: { body: string }) => {
        const payload = JSON.parse(body);
        const embeddings = payload.input.map(() => [0.1, 0.2, 0.3]);
        return Promise.resolve({
          status: 200,
          text: JSON.stringify({
            data: embeddings.map((e: number[], i: number) => ({ index: i, embedding: e })),
          }),
        });
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
        maxBatchSize: 5,
      });

      const texts = Array.from({ length: 12 }, (_, i) => `text-${i}`);
      const result = await provider.generateEmbeddings(texts);

      expect(httpRequest).toHaveBeenCalledTimes(3);
      expect(result).toHaveLength(12);

      const firstBatch = JSON.parse(httpRequest.mock.calls[0][0].body);
      const secondBatch = JSON.parse(httpRequest.mock.calls[1][0].body);
      const thirdBatch = JSON.parse(httpRequest.mock.calls[2][0].body);

      expect(firstBatch.input).toHaveLength(5);
      expect(secondBatch.input).toHaveLength(5);
      expect(thirdBatch.input).toHaveLength(2);
    });

    it("respects custom maxBatchSize configuration", async () => {
      httpRequest.mockImplementation(({ body }: { body: string }) => {
        const payload = JSON.parse(body);
        expect(payload.input.length).toBeLessThanOrEqual(3);
        return Promise.resolve({
          status: 200,
          text: JSON.stringify({
            data: payload.input.map((_: string, i: number) => ({ index: i, embedding: [0.1] })),
          }),
        });
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
        maxBatchSize: 3,
      });

      await provider.generateEmbeddings(["a", "b", "c", "d", "e"]);

      expect(httpRequest).toHaveBeenCalledTimes(2);
    });

    it("aggregates results from multiple batches in order", async () => {
      let callIndex = 0;
      httpRequest.mockImplementation(({ body }: { body: string }) => {
        const payload = JSON.parse(body);
        const batchNum = callIndex++;
        const embeddings = payload.input.map((_: string, i: number) => [batchNum, i]);
        return Promise.resolve({
          status: 200,
          text: JSON.stringify({
            data: embeddings.map((e: number[], i: number) => ({ index: i, embedding: e })),
          }),
        });
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
        maxBatchSize: 2,
      });

      const result = await provider.generateEmbeddings(["a", "b", "c", "d", "e"]);

      expect(result).toEqual([
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
        [2, 0],
      ]);
    });

    it("uses default maxBatchSize of 100", () => {
      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      expect(provider.getMaxBatchSize()).toBe(100);
    });
  });

  describe("error handling", () => {
    it("parses error.message format", async () => {
      httpRequest.mockResolvedValue({
        status: 400,
        text: JSON.stringify({
          error: { message: "Invalid input format" },
        }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      await expect(provider.generateEmbeddings(["hello"])).rejects.toThrow(
        "Custom API error 400: Invalid input format"
      );
    });

    it("parses message format", async () => {
      httpRequest.mockResolvedValue({
        status: 500,
        text: JSON.stringify({ message: "Internal server error" }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      await expect(provider.generateEmbeddings(["hello"])).rejects.toThrow(
        "Custom API error 500: Internal server error"
      );
    });

    it("parses detail format", async () => {
      httpRequest.mockResolvedValue({
        status: 422,
        text: JSON.stringify({ detail: "Validation error" }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      await expect(provider.generateEmbeddings(["hello"])).rejects.toThrow(
        "Custom API error 422: Validation error"
      );
    });

    it("falls back to raw text on unparseable error", async () => {
      httpRequest.mockResolvedValue({
        status: 503,
        text: "Service temporarily unavailable",
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      await expect(provider.generateEmbeddings(["hello"])).rejects.toThrow(
        "Custom API error 503: Service temporarily unavailable"
      );
    });

    it("handles missing response text", async () => {
      httpRequest.mockResolvedValue({
        status: 502,
        text: "",
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      await expect(provider.generateEmbeddings(["hello"])).rejects.toThrow(
        "Custom API error 502: Unknown error"
      );
    });
  });

  describe("getModels", () => {
    it("returns configured model first if not in common list", async () => {
      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "my-custom-model",
      });

      const models = await provider.getModels();

      expect(models[0]).toBe("my-custom-model");
      expect(models.length).toBeGreaterThan(1);
    });

    it("returns common models list when configured model is common", async () => {
      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-004",
      });

      const models = await provider.getModels();

      expect(models).toContain("text-embedding-004");
      expect(models).toContain("all-MiniLM-L6-v2");
    });
  });

  describe("validateConfiguration", () => {
    it("returns true when configuration is valid", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      const result = await provider.validateConfiguration();

      expect(result).toBe(true);
      expect(httpRequest).toHaveBeenCalledTimes(1);
    });

    it("returns false when endpoint is invalid URL", async () => {
      const provider = new CustomProvider({
        endpoint: "not-a-url",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      const result = await provider.validateConfiguration();

      expect(result).toBe(false);
    });

    it("returns false when test embedding fails", async () => {
      httpRequest.mockRejectedValue(new Error("Connection refused"));

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      const result = await provider.validateConfiguration();

      expect(result).toBe(false);
    });
  });

  describe("custom headers", () => {
    it("includes custom headers in request", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
        headers: {
          "X-Custom-Header": "custom-value",
        },
      });

      await provider.generateEmbeddings(["hello"]);

      const call = httpRequest.mock.calls[0][0];
      expect(call.headers["X-Custom-Header"]).toBe("custom-value");
      expect(call.headers["Content-Type"]).toBe("application/json");
    });
  });

  describe("json parsing", () => {
    it("uses response.json when available", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        json: {
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        },
        text: "invalid json",
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:1234/v1/embeddings",
        apiKey: "",
        model: "text-embedding-3-small",
      });

      const result = await provider.generateEmbeddings(["hello"]);

      expect(result).toEqual([[0.1, 0.2, 0.3]]);
    });
  });
});
