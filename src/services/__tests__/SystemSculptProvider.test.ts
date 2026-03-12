jest.mock("../../utils/httpClient", () => {
  return {
    httpRequest: jest.fn(),
    isHostTemporarilyDisabled: jest.fn(() => ({ disabled: false, retryInMs: 0 })),
  };
});

jest.mock("../../utils/errorLogger", () => ({
  errorLogger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../../constants/api", () => {
  const actual = jest.requireActual("../../constants/api");
  return {
    ...actual,
  };
});

const { httpRequest } = require("../../utils/httpClient") as {
  httpRequest: jest.Mock;
};
const { errorLogger } = require("../../utils/errorLogger") as {
  errorLogger: {
    debug: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };
};

import { SystemSculptProvider } from "../embeddings/providers/SystemSculptProvider";

describe("SystemSculptProvider", () => {
  beforeEach(() => {
    httpRequest.mockReset();
    errorLogger.debug.mockReset();
    errorLogger.warn.mockReset();
    errorLogger.error.mockReset();
  });

  it("pins custom hosted base URLs back to production before treating forbidden HTML as HOST_UNAVAILABLE", async () => {
    httpRequest
      .mockRejectedValueOnce({
        status: 403,
        text: "<html>forbidden</html>",
        headers: { "content-type": "text/html" },
      });

    const provider = new SystemSculptProvider("test-license", "https://notes.systemsculpt.com/api");
    await expect(provider.generateEmbeddings(["hello world"])).rejects.toMatchObject({
      status: 403,
      code: "HOST_UNAVAILABLE",
    });
    expect(httpRequest).toHaveBeenCalledTimes(1);
    expect(httpRequest.mock.calls[0][0].url).toBe("https://api.systemsculpt.com/api/v1/embeddings");
  });

  it("propagates structured BAD_REQUEST messages from the API", async () => {
    httpRequest.mockRejectedValue({
      status: 400,
      text: JSON.stringify({ error: "BAD_REQUEST", message: "Text at index 0 invalid: Text is empty" }),
      headers: { "content-type": "application/json" },
    });

    const provider = new SystemSculptProvider("test-license");

    await expect(provider.generateEmbeddings(["valid input"])).rejects.toMatchObject({
      message: "API error 400: Text at index 0 invalid: Text is empty (BAD_REQUEST)",
      status: 400,
      code: "HTTP_ERROR",
    });
  });

  it("treats authentication throttling on 429 as RATE_LIMITED (not license invalid)", async () => {
    httpRequest.mockRejectedValue({
      status: 429,
      text: JSON.stringify({ error: "too many authentication failures" }),
      headers: { "content-type": "application/json" },
    });

    const provider = new SystemSculptProvider("bad-license");

    await expect(provider.generateEmbeddings(["valid input"])).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      licenseRelated: false,
    });
  });

  it("does not treat non-auth 403 JSON responses as license errors", async () => {
    httpRequest.mockRejectedValue({
      status: 403,
      text: JSON.stringify({ error: "REQUEST_BLOCKED", message: "Request blocked by gateway policy" }),
      headers: { "content-type": "application/json" },
    });

    const provider = new SystemSculptProvider("test-license");

    await expect(provider.generateEmbeddings(["valid input"])).rejects.toMatchObject({
      status: 403,
      code: "HTTP_ERROR",
      licenseRelated: false,
    });
  });

  it("splits client-side batches larger than 25 texts before contacting the API", async () => {
    httpRequest.mockImplementation(({ body }: { body: string }) => {
      const payload = JSON.parse(body);
      expect(Array.isArray(payload.texts)).toBe(true);
      expect(payload.texts.length).toBeLessThanOrEqual(25);
      const embeddings = payload.texts.map(() => [0.1, 0.2, 0.3]);
      return Promise.resolve({
        status: 200,
        text: JSON.stringify({ embeddings }),
        headers: { "content-type": "application/json" },
      });
    });

    const provider = new SystemSculptProvider("test-license");
    const oversized = Array.from({ length: 51 }, (_, idx) => `text-${idx}`);

    const result = await provider.generateEmbeddings(oversized);

    expect(result).toHaveLength(51);
    expect(httpRequest).toHaveBeenCalledTimes(3);
  });

  it("omits hosted inference override fields from SystemSculpt embeddings requests", async () => {
    httpRequest.mockImplementation(({ body }: { body: string }) => {
      const payload = JSON.parse(body);
      expect(payload).toEqual({
        texts: ["hello world"],
        inputType: "document",
      });
      return Promise.resolve({
        status: 200,
        text: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
        headers: { "content-type": "application/json" },
      });
    });

    const provider = new SystemSculptProvider("test-license");

    await expect(provider.generateEmbeddings(["hello world"])).resolves.toEqual([[0.1, 0.2, 0.3]]);
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  it("extracts readable messages from nested upgrade_required payloads", async () => {
    httpRequest.mockRejectedValue({
      status: 426,
      text: JSON.stringify({
        error: {
          code: "upgrade_required",
          message: "Plugin version 4.15.1 or newer is required for embeddings.",
        },
      }),
      headers: { "content-type": "application/json" },
    });

    const provider = new SystemSculptProvider("test-license");

    await expect(provider.generateEmbeddings(["valid input"])).rejects.toMatchObject({
      message: "API error 426: Plugin version 4.15.1 or newer is required for embeddings. (upgrade_required)",
      status: 426,
      code: "HTTP_ERROR",
    });
  });

  it("suppresses duplicate HOST_UNAVAILABLE console errors during the outage window", async () => {
    jest.useFakeTimers();
    httpRequest.mockRejectedValue({
      status: 503,
      text: JSON.stringify({ error: "Credits system is temporarily unavailable. Please try again later." }),
      headers: { "content-type": "application/json" },
    });

    const provider = new SystemSculptProvider("test-license");

    await expect(provider.generateEmbeddings(["first"])).rejects.toMatchObject({
      code: "HOST_UNAVAILABLE",
      status: 503,
    });
    expect(errorLogger.error).toHaveBeenCalledTimes(1);

    await expect(provider.generateEmbeddings(["second"])).rejects.toMatchObject({
      code: "HOST_UNAVAILABLE",
      status: 503,
    });
    expect(errorLogger.error).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(121_000);

    await expect(provider.generateEmbeddings(["third"])).rejects.toMatchObject({
      code: "HOST_UNAVAILABLE",
      status: 503,
    });
    expect(errorLogger.warn).toHaveBeenCalledWith(
      'SystemSculpt embeddings outage persisted; suppressed duplicate logs',
      expect.objectContaining({
        source: 'SystemSculptProvider',
        method: 'generateEmbeddings',
      })
    );
    expect(errorLogger.error).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });
});
