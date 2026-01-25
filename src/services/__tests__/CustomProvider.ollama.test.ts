jest.mock("../../utils/httpClient", () => ({
  httpRequest: jest.fn(),
}));

const { httpRequest } = require("../../utils/httpClient") as {
  httpRequest: jest.Mock;
};

import { CustomProvider } from "../embeddings/providers/CustomProvider";

describe("CustomProvider Ollama mode", () => {
  beforeEach(() => {
    httpRequest.mockReset();
  });

  describe("endpoint detection", () => {
    it("detects Ollama style from /api/embeddings endpoint", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ embedding: [0.1, 0.2, 0.3] }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
      });

      await provider.generateEmbeddings(["hello"]);

      const body = JSON.parse(httpRequest.mock.calls[0][0].body);
      expect(body.prompt).toBe("hello");
      expect(body.input).toBeUndefined();
    });

    it("uses OpenAI style for other endpoints", async () => {
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

      const body = JSON.parse(httpRequest.mock.calls[0][0].body);
      expect(body.input).toEqual(["hello"]);
      expect(body.prompt).toBeUndefined();
    });

    it("detection is case-insensitive", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ embedding: [0.1, 0.2, 0.3] }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/API/EMBEDDINGS",
        apiKey: "",
        model: "nomic-embed-text",
      });

      await provider.generateEmbeddings(["hello"]);

      const body = JSON.parse(httpRequest.mock.calls[0][0].body);
      expect(body.prompt).toBeDefined();
    });
  });

  describe("parallel processing", () => {
    it("sends individual requests for each text", async () => {
      httpRequest.mockImplementation(({ body }: { body: string }) => {
        const payload = JSON.parse(body);
        return Promise.resolve({
          status: 200,
          text: JSON.stringify({ embedding: [0.1, 0.2, payload.prompt.length / 10] }),
        });
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
      });

      await provider.generateEmbeddings(["short", "medium text", "longer text here"]);

      expect(httpRequest).toHaveBeenCalledTimes(3);

      const prompts = httpRequest.mock.calls.map((call: any[]) => JSON.parse(call[0].body).prompt);
      expect(prompts).toContain("short");
      expect(prompts).toContain("medium text");
      expect(prompts).toContain("longer text here");
    });

    it("limits concurrency to 5 parallel requests", async () => {
      let currentConcurrency = 0;
      let maxObservedConcurrency = 0;

      httpRequest.mockImplementation(async () => {
        currentConcurrency++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, currentConcurrency);

        await new Promise((resolve) => setTimeout(resolve, 50));

        currentConcurrency--;
        return {
          status: 200,
          text: JSON.stringify({ embedding: [0.1, 0.2, 0.3] }),
        };
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
      });

      const texts = Array.from({ length: 15 }, (_, i) => `text-${i}`);
      await provider.generateEmbeddings(texts);

      expect(maxObservedConcurrency).toBeLessThanOrEqual(5);
      expect(httpRequest).toHaveBeenCalledTimes(15);
    });

    it("uses prompt field instead of input for Ollama", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ embedding: [0.1, 0.2, 0.3] }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
      });

      await provider.generateEmbeddings(["hello world"]);

      const body = JSON.parse(httpRequest.mock.calls[0][0].body);
      expect(body.prompt).toBe("hello world");
      expect(body.model).toBe("nomic-embed-text");
      expect(body.input).toBeUndefined();
    });

    it("maps task_type to retrieval_query for query inputType", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ embedding: [0.1, 0.2, 0.3] }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
      });

      await provider.generateEmbeddings(["search query"], { inputType: "query" });

      const body = JSON.parse(httpRequest.mock.calls[0][0].body);
      expect(body.task_type).toBe("retrieval_query");
    });

    it("maps task_type to retrieval_document by default", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ embedding: [0.1, 0.2, 0.3] }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
      });

      await provider.generateEmbeddings(["document content"]);

      const body = JSON.parse(httpRequest.mock.calls[0][0].body);
      expect(body.task_type).toBe("retrieval_document");
    });

    it("returns embeddings in original order despite parallel execution", async () => {
      const delays = [100, 10, 50, 30, 70];

      httpRequest.mockImplementation(async ({ body }: { body: string }) => {
        const payload = JSON.parse(body);
        const index = parseInt(payload.prompt.split("-")[1], 10);
        await new Promise((resolve) => setTimeout(resolve, delays[index]));
        return {
          status: 200,
          text: JSON.stringify({ embedding: [index, index * 2, index * 3] }),
        };
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
      });

      const texts = ["text-0", "text-1", "text-2", "text-3", "text-4"];
      const result = await provider.generateEmbeddings(texts);

      expect(result).toEqual([
        [0, 0, 0],
        [1, 2, 3],
        [2, 4, 6],
        [3, 6, 9],
        [4, 8, 12],
      ]);
    });
  });

  describe("Ollama response formats", () => {
    it("handles embedding field directly on response", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ embedding: [0.1, 0.2, 0.3, 0.4] }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
      });

      const result = await provider.generateEmbeddings(["hello"]);

      expect(result).toEqual([[0.1, 0.2, 0.3, 0.4]]);
    });

    it("handles data[0].embedding nested format", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({
          data: [{ embedding: [0.5, 0.6, 0.7] }],
        }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
      });

      const result = await provider.generateEmbeddings(["hello"]);

      expect(result).toEqual([[0.5, 0.6, 0.7]]);
    });

    it("throws on unsupported Ollama response format", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ result: "unexpected" }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
      });

      await expect(provider.generateEmbeddings(["hello"])).rejects.toThrow(
        "Unsupported response format from Ollama endpoint"
      );
    });

    it("sets expectedDimension from Ollama response", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
      });

      expect(provider.expectedDimension).toBeUndefined();
      await provider.generateEmbeddings(["hello"]);
      expect(provider.expectedDimension).toBe(6);
    });
  });

  describe("error propagation", () => {
    it("stops on first error and surfaces it", async () => {
      let callCount = 0;
      httpRequest.mockImplementation(async () => {
        callCount++;
        if (callCount === 3) {
          return {
            status: 500,
            text: JSON.stringify({ message: "Server error on third request" }),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          status: 200,
          text: JSON.stringify({ embedding: [0.1, 0.2, 0.3] }),
        };
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
      });

      await expect(
        provider.generateEmbeddings(["a", "b", "c", "d", "e", "f", "g", "h"])
      ).rejects.toThrow("Custom API error 500: Server error on third request");
    });

    it("completes in-flight requests before throwing", async () => {
      const completedIndices: number[] = [];
      let callIndex = 0;

      httpRequest.mockImplementation(async () => {
        const index = callIndex++;
        if (index === 2) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            status: 500,
            text: JSON.stringify({ message: "Error" }),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        completedIndices.push(index);
        return {
          status: 200,
          text: JSON.stringify({ embedding: [0.1] }),
        };
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
      });

      await expect(
        provider.generateEmbeddings(["a", "b", "c", "d", "e"])
      ).rejects.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(completedIndices.length).toBeGreaterThan(0);
    });
  });

  describe("batch handling with Ollama", () => {
    it("splits large inputs into batches for Ollama endpoints too", async () => {
      httpRequest.mockResolvedValue({
        status: 200,
        text: JSON.stringify({ embedding: [0.1, 0.2, 0.3] }),
      });

      const provider = new CustomProvider({
        endpoint: "http://localhost:11434/api/embeddings",
        apiKey: "",
        model: "nomic-embed-text",
        maxBatchSize: 3,
      });

      const texts = Array.from({ length: 7 }, (_, i) => `text-${i}`);
      const result = await provider.generateEmbeddings(texts);

      expect(result).toHaveLength(7);
      expect(httpRequest).toHaveBeenCalledTimes(7);
    });
  });
});
