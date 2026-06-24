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

const { httpRequest } = require("../../utils/httpClient") as {
  httpRequest: jest.Mock;
};

import { SystemSculptProvider } from "../embeddings/providers/SystemSculptProvider";

/**
 * BUG-01: keep returned vectors aligned with their input chunks.
 *
 * `generateEmbeddings` must return exactly one slot per ORIGINAL input, in
 * order. Whitespace-only / empty inputs (which the provider must not send to
 * the API) are represented as `null` at their original index — the processor
 * (`EmbeddingsProcessor.processBatch`) requires `embeddings.length ===
 * texts.length` and skips per-index `null`. Dropping the entry instead shifts
 * every later vector onto the wrong chunk (silent semantic-search corruption).
 */
describe("SystemSculptProvider vector/chunk alignment (BUG-01)", () => {
  beforeEach(() => {
    httpRequest.mockReset();
  });

  // The HTTP layer echoes one vector per text the provider actually sends,
  // tagged with the text so we can assert which chunk each vector binds to.
  function echoOneVectorPerSentText() {
    httpRequest.mockImplementation(({ body }: { body: string }) => {
      const payload = JSON.parse(body);
      const embeddings = (payload.texts as string[]).map((text, idx) => [
        idx,
        text.length,
      ]);
      return Promise.resolve({
        status: 200,
        text: JSON.stringify({ embeddings }),
        headers: { "content-type": "application/json" },
      });
    });
  }

  it("preserves positional alignment when a whitespace-only chunk sits in the middle", async () => {
    echoOneVectorPerSentText();
    const provider = new SystemSculptProvider("test-license");

    const result = await provider.generateEmbeddings(["real text", "   ", "more text"]);

    // One slot per original input, in order.
    expect(result).toHaveLength(3);
    // The whitespace slot carries no vector...
    expect(result[1]).toBeNull();
    // ...and the surrounding chunks keep their own vectors (not shifted up).
    expect(Array.isArray(result[0])).toBe(true);
    expect(Array.isArray(result[2])).toBe(true);
    // The API was only asked to embed the two real chunks.
    expect(httpRequest).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(httpRequest.mock.calls[0][0].body).texts as string[];
    expect(sent).toEqual(["real text", "more text"]);
  });

  it("returns an all-null array (never a shorter one) when every input is whitespace", async () => {
    echoOneVectorPerSentText();
    const provider = new SystemSculptProvider("test-license");

    const result = await provider.generateEmbeddings(["   ", "\t", "\n"]);

    expect(result).toHaveLength(3);
    expect(result).toEqual([null, null, null]);
    // Nothing valid to embed -> no API call.
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it("keeps alignment across client-side sub-batches with interspersed empties", async () => {
    echoOneVectorPerSentText();
    const provider = new SystemSculptProvider("test-license");

    // 30 inputs (> the 25/request cap) with a whitespace chunk at index 5.
    const inputs = Array.from({ length: 30 }, (_, idx) =>
      idx === 5 ? "   " : `chunk-${idx}`,
    );

    const result = await provider.generateEmbeddings(inputs);

    expect(result).toHaveLength(30);
    expect(result[5]).toBeNull();
    for (let i = 0; i < result.length; i++) {
      if (i === 5) continue;
      expect(Array.isArray(result[i])).toBe(true);
    }
  });

  it("throws loudly if the server drops a row instead of silently misaligning", async () => {
    // Two valid inputs, but the server returns only one vector.
    httpRequest.mockResolvedValue({
      status: 200,
      text: JSON.stringify({ embeddings: [[0.1, 0.2]] }),
      headers: { "content-type": "application/json" },
    });
    const provider = new SystemSculptProvider("test-license");

    await expect(
      provider.generateEmbeddings(["alpha", "beta"]),
    ).rejects.toThrow(/count|length|mismatch/i);
  });
});
