jest.mock("../../utils/httpClient", () => {
  return {
    httpRequest: jest.fn(),
    isHostTemporarilyDisabled: jest.fn(() => ({ disabled: false, retryInMs: 0 })),
  };
});

jest.mock("../../constants/api", () => {
  const actual = jest.requireActual("../../constants/api");
  return {
    ...actual,
  };
});

const { httpRequest } = require("../../utils/httpClient") as {
  httpRequest: jest.Mock;
};

import { SystemSculptProvider } from "../embeddings/providers/SystemSculptProvider";

describe("SystemSculptProvider", () => {
  beforeEach(() => {
    httpRequest.mockReset();
  });

  it("treats forbidden HTML responses as HOST_UNAVAILABLE (no fallback retries)", async () => {
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
    expect(httpRequest.mock.calls[0][0].url).toBe("https://notes.systemsculpt.com/api/v1/embeddings");
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

  it("treats authentication failures on 429 as LICENSE_INVALID", async () => {
    httpRequest.mockRejectedValue({
      status: 429,
      text: JSON.stringify({ error: "too many authentication failures" }),
      headers: { "content-type": "application/json" },
    });

    const provider = new SystemSculptProvider("bad-license");

    await expect(provider.generateEmbeddings(["valid input"])).rejects.toMatchObject({
      status: 429,
      code: "LICENSE_INVALID",
      licenseRelated: true,
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
});
