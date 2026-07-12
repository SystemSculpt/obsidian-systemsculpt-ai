import { StreamingErrorHandler } from "../StreamingErrorHandler";
import { ERROR_CODES, SystemSculptError } from "../../utils/errors";

describe("StreamingErrorHandler", () => {
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
