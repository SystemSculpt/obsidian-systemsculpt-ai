jest.mock("../../utils/httpClient", () => ({
  httpRequest: jest.fn(),
}));

const { httpRequest } = require("../../utils/httpClient") as {
  httpRequest: jest.Mock;
};

import { CustomProvider } from "../embeddings/providers/CustomProvider";
import {
  EmbeddingsProviderError,
  isEmbeddingsProviderError,
} from "../embeddings/providers/ProviderError";

const ENDPOINT = "http://localhost:1234/v1/embeddings";

function provider() {
  return new CustomProvider({
    endpoint: ENDPOINT,
    apiKey: "",
    model: "text-embedding-3-small",
  });
}

async function capture(p: Promise<unknown>): Promise<EmbeddingsProviderError> {
  try {
    await p;
  } catch (error) {
    if (isEmbeddingsProviderError(error)) return error;
    throw new Error(`expected EmbeddingsProviderError, got: ${String(error)}`);
  }
  throw new Error("expected the call to reject");
}

describe("CustomProvider — response-shape coverage (#153)", () => {
  beforeEach(() => httpRequest.mockReset());

  it("accepts LM Studio's top-level singular `{embedding: [...]}`", async () => {
    httpRequest.mockResolvedValue({
      status: 200,
      text: JSON.stringify({ embedding: [0.1, 0.2, 0.3] }),
    });

    const result = await provider().generateEmbeddings(["hello"]);
    expect(result).toEqual([[0.1, 0.2, 0.3]]);
  });

  it("accepts a top-level plural `{embeddings: [[...]]}`", async () => {
    httpRequest.mockResolvedValue({
      status: 200,
      text: JSON.stringify({
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      }),
    });

    const result = await provider().generateEmbeddings(["a", "b"]);
    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it("throws a typed UNEXPECTED_RESPONSE on an unrecognized 200 body", async () => {
    httpRequest.mockResolvedValue({
      status: 200,
      text: JSON.stringify({ unexpected: "format" }),
    });

    const err = await capture(provider().generateEmbeddings(["hello"]));
    expect(err.code).toBe("UNEXPECTED_RESPONSE");
    // Preserve the legacy message so the original suite stays green.
    expect(err.message).toContain("Unsupported response format from custom endpoint");
  });
});

describe("CustomProvider — typed HTTP errors", () => {
  beforeEach(() => httpRequest.mockReset());

  it("classifies 429 as transient RATE_LIMITED with Retry-After", async () => {
    httpRequest.mockResolvedValue({
      status: 429,
      text: JSON.stringify({ error: { message: "slow down" } }),
      headers: { "retry-after": "3" },
    });

    const err = await capture(provider().generateEmbeddings(["hello"]));
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.transient).toBe(true);
    expect(err.status).toBe(429);
    expect(err.retryInMs).toBe(3000);
    // Legacy message format preserved.
    expect(err.message).toContain("Custom API error 429: slow down");
  });

  it("classifies 5xx as transient HTTP_ERROR", async () => {
    httpRequest.mockResolvedValue({
      status: 503,
      text: "Service temporarily unavailable",
    });

    const err = await capture(provider().generateEmbeddings(["hello"]));
    expect(err.code).toBe("HTTP_ERROR");
    expect(err.transient).toBe(true);
    expect(err.status).toBe(503);
  });

  it("classifies other 4xx as permanent HTTP_ERROR", async () => {
    httpRequest.mockResolvedValue({
      status: 400,
      text: JSON.stringify({ error: { message: "bad request" } }),
    });

    const err = await capture(provider().generateEmbeddings(["hello"]));
    expect(err.code).toBe("HTTP_ERROR");
    expect(err.transient).toBe(false);
    expect(err.status).toBe(400);
  });

  it("wraps a transport failure as a transient NETWORK_ERROR", async () => {
    httpRequest.mockRejectedValue(new Error("Connection refused"));

    const err = await capture(provider().generateEmbeddings(["hello"]));
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.transient).toBe(true);
    expect(err.message).toContain("Connection refused");
  });

  it("does not double-wrap an EmbeddingsProviderError thrown from the Ollama path", async () => {
    // /api/embeddings -> Ollama path; an unrecognized body must surface as a
    // typed error, not be re-wrapped as NETWORK_ERROR by the outer catch.
    httpRequest.mockResolvedValue({
      status: 200,
      text: JSON.stringify({ nope: true }),
    });
    const ollama = new CustomProvider({
      endpoint: "http://localhost:11434/api/embeddings",
      apiKey: "",
      model: "nomic-embed-text",
    });

    const err = await capture(ollama.generateEmbeddings(["hello"]));
    expect(err.code).toBe("UNEXPECTED_RESPONSE");
  });
});
