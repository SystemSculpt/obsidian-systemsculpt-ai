import { StreamingErrorHandler } from "../StreamingErrorHandler";
import { ERROR_CODES, SystemSculptError } from "../../utils/errors";

import fixture from "../../../testing/fixtures/retry-after.json";

describe("StreamingErrorHandler", () => {
  it.each(fixture.cases)("projects $name as chat retry seconds", async ({ header, milliseconds }) => {
    const now = jest.spyOn(Date, "now").mockReturnValue(fixture.now);
    try {
      const response = new Response("{}", { status: 429, headers: header === null ? {} : { "Retry-After": header } });
      await expect(StreamingErrorHandler.handleResponseError(response)).rejects.toMatchObject({
        metadata: { retryAfterSeconds: milliseconds === null ? undefined : Math.ceil(milliseconds / 1_000) },
      });
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    [null, { retry_after_seconds: 1.25 }, 2],
    [null, { retry_after: 3 }, 3],
    [null, { error: { retry_after_seconds: 2.5 } }, 3],
    ["invalid", { retry_after_seconds: 4 }, 4],
    ["0", { retry_after_seconds: 4 }, 0],
  ] as const)("uses payload fallback with header %s and body %j", async (header, payload, seconds) => {
    const response = new Response(JSON.stringify(payload), { status: 429, headers: header === null ? {} : { "Retry-After": header } });
    await expect(StreamingErrorHandler.handleResponseError(response)).rejects.toMatchObject({
      metadata: { retryAfterSeconds: seconds },
    });
  });

  it.each([
    [401, ERROR_CODES.INVALID_LICENSE],
    [402, ERROR_CODES.INSUFFICIENT_CREDITS],
    [409, ERROR_CODES.TURN_IN_FLIGHT],
    [429, ERROR_CODES.RATE_LIMIT_ERROR],
    [503, ERROR_CODES.SERVICE_UNAVAILABLE],
  ] as const)("maps managed HTTP %s to %s", async (status, code) => {
    const response = new Response(JSON.stringify({ error: { message: "managed failure" } }), {
      status,
      headers: status === 429 ? { "Retry-After": "3" } : undefined,
    });

    await expect(StreamingErrorHandler.handleResponseError(response, { endpoint: "/credits" }))
      .rejects.toMatchObject({ code, statusCode: status, message: "managed failure" });
  });

  it("marks managed authentication failures for Account recovery", async () => {
    const response = new Response("unauthorized", { status: 401 });
    try {
      await StreamingErrorHandler.handleResponseError(response);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemSculptError);
      expect((error as SystemSculptError).metadata?.licenseFailure).toBe(true);
    }
  });
});
