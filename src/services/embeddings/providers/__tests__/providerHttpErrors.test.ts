import { describe, expect, it } from "@jest/globals";
import {
  buildHttpErrorOptions,
  classifyEmbeddingsHttpStatus,
  parseRetryAfterMs,
} from "../providerHttpErrors";

describe("classifyEmbeddingsHttpStatus", () => {
  it("classifies 429 as a transient rate-limit", () => {
    const c = classifyEmbeddingsHttpStatus(429);
    expect(c.code).toBe("RATE_LIMITED");
    expect(c.transient).toBe(true);
  });

  it("carries Retry-After (seconds) into retryInMs for a 429", () => {
    const c = classifyEmbeddingsHttpStatus(429, { "retry-after": "2" });
    expect(c.retryInMs).toBe(2000);
  });

  it("classifies 5xx and 408 as transient HTTP errors", () => {
    expect(classifyEmbeddingsHttpStatus(500)).toMatchObject({
      code: "HTTP_ERROR",
      transient: true,
    });
    expect(classifyEmbeddingsHttpStatus(503).transient).toBe(true);
    expect(classifyEmbeddingsHttpStatus(408).transient).toBe(true);
  });

  it("treats a missing/zero status as transient (no usable response)", () => {
    expect(classifyEmbeddingsHttpStatus(0)).toMatchObject({
      code: "HTTP_ERROR",
      transient: true,
    });
  });

  it("classifies other 4xx as permanent HTTP errors", () => {
    expect(classifyEmbeddingsHttpStatus(400)).toMatchObject({
      code: "HTTP_ERROR",
      transient: false,
    });
    expect(classifyEmbeddingsHttpStatus(401).transient).toBe(false);
    expect(classifyEmbeddingsHttpStatus(422).transient).toBe(false);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses integer seconds (case-insensitive header key)", () => {
    expect(parseRetryAfterMs({ "Retry-After": "5" })).toBe(5000);
    expect(parseRetryAfterMs({ "retry-after": "0" })).toBe(0);
  });

  it("returns undefined for missing / non-numeric / negative values", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs({})).toBeUndefined();
    expect(parseRetryAfterMs({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })).toBeUndefined();
    expect(parseRetryAfterMs({ "retry-after": "-3" })).toBeUndefined();
  });
});

describe("buildHttpErrorOptions", () => {
  it("merges classification with provider/endpoint context", () => {
    const opts = buildHttpErrorOptions({
      status: 429,
      headers: { "retry-after": "1" },
      providerId: "custom",
      endpoint: "http://host/v1/embeddings",
      details: { sample: "x" },
    });
    expect(opts).toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      transient: true,
      retryInMs: 1000,
      providerId: "custom",
      endpoint: "http://host/v1/embeddings",
      details: { sample: "x" },
    });
  });
});
