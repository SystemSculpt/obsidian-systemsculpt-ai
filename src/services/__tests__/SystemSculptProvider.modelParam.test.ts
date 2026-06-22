/**
 * Regression guard for #179: the SystemSculpt managed embeddings endpoint runs
 * server-controlled inference and rejects a client-supplied `model` with
 * "API error 400 ... unsupported parameter model". The provider must therefore
 * send only the supported contract fields (`texts`, `inputType`) and never a
 * `model` in the request body.
 */
jest.mock("../../utils/httpClient", () => ({
  httpRequest: jest.fn(),
  isHostTemporarilyDisabled: jest.fn(() => ({ disabled: false, retryInMs: 0 })),
}));

jest.mock("../../utils/errorLogger", () => ({
  errorLogger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { httpRequest } = require("../../utils/httpClient") as {
  httpRequest: jest.Mock;
};

import { SystemSculptProvider } from "../embeddings/providers/SystemSculptProvider";

describe("SystemSculptProvider request body (#179 guard)", () => {
  beforeEach(() => httpRequest.mockReset());

  it("never sends a `model` field to the managed endpoint", async () => {
    httpRequest.mockResolvedValue({
      status: 200,
      text: JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
      headers: { "content-type": "application/json" },
    });

    const provider = new SystemSculptProvider("test-license");
    await provider.generateEmbeddings(["hello world"]);

    expect(httpRequest).toHaveBeenCalled();
    const body = JSON.parse(httpRequest.mock.calls[0][0].body);
    expect(body).not.toHaveProperty("model");
    expect(body.texts).toEqual(["hello world"]);
    expect(body.inputType).toBe("document");
  });
});
