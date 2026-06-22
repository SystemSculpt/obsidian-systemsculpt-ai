import {
  buildTranscriptionHttpErrorOptions,
  classifyTranscriptionHttpStatus,
  parseRetryAfterMs,
} from "../providerHttpErrors";

describe("parseRetryAfterMs", () => {
  it("parses integer seconds case-insensitively into ms", () => {
    expect(parseRetryAfterMs({ "Retry-After": "30" })).toBe(30_000);
    expect(parseRetryAfterMs({ "retry-after": "1" })).toBe(1_000);
    expect(parseRetryAfterMs({ "RETRY-AFTER": " 2 " })).toBe(2_000);
  });

  it("returns undefined for missing / non-numeric / negative / HTTP-date values", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs({})).toBeUndefined();
    expect(parseRetryAfterMs({ "retry-after": "soon" })).toBeUndefined();
    expect(parseRetryAfterMs({ "retry-after": "-5" })).toBeUndefined();
    expect(parseRetryAfterMs({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })).toBeUndefined();
  });
});

describe("classifyTranscriptionHttpStatus", () => {
  it("classifies 429 as transient RATE_LIMITED with Retry-After", () => {
    expect(classifyTranscriptionHttpStatus(429, { "retry-after": "12" })).toEqual({
      code: "RATE_LIMITED",
      transient: true,
      retryInMs: 12_000,
    });
  });

  it("classifies 408 and 5xx and unknown-transport as transient HTTP_ERROR", () => {
    expect(classifyTranscriptionHttpStatus(408)).toEqual({ code: "HTTP_ERROR", transient: true });
    expect(classifyTranscriptionHttpStatus(500)).toEqual({ code: "HTTP_ERROR", transient: true });
    expect(classifyTranscriptionHttpStatus(503)).toEqual({ code: "HTTP_ERROR", transient: true });
    expect(classifyTranscriptionHttpStatus(0)).toEqual({ code: "HTTP_ERROR", transient: true });
    expect(classifyTranscriptionHttpStatus(-1)).toEqual({ code: "HTTP_ERROR", transient: true });
  });

  it("classifies other 4xx as permanent HTTP_ERROR", () => {
    expect(classifyTranscriptionHttpStatus(400)).toEqual({ code: "HTTP_ERROR", transient: false });
    expect(classifyTranscriptionHttpStatus(401)).toEqual({ code: "HTTP_ERROR", transient: false });
    expect(classifyTranscriptionHttpStatus(404)).toEqual({ code: "HTTP_ERROR", transient: false });
    expect(classifyTranscriptionHttpStatus(422)).toEqual({ code: "HTTP_ERROR", transient: false });
  });
});

describe("buildTranscriptionHttpErrorOptions", () => {
  it("merges the classification with provider/endpoint context", () => {
    const options = buildTranscriptionHttpErrorOptions({
      status: 429,
      headers: { "retry-after": "5" },
      providerId: "custom",
      endpoint: "https://whisper.example.com/v1/audio/transcriptions",
      details: { requestId: "req-1" },
    });
    expect(options).toEqual({
      code: "RATE_LIMITED",
      status: 429,
      transient: true,
      retryInMs: 5_000,
      providerId: "custom",
      endpoint: "https://whisper.example.com/v1/audio/transcriptions",
      details: { requestId: "req-1" },
    });
  });

  it("carries a permanent 400 through with no retryInMs", () => {
    const options = buildTranscriptionHttpErrorOptions({
      status: 400,
      providerId: "custom",
      endpoint: "https://whisper.example.com",
    });
    expect(options.code).toBe("HTTP_ERROR");
    expect(options.transient).toBe(false);
    expect(options.retryInMs).toBeUndefined();
  });
});
