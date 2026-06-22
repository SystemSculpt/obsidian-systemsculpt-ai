import {
  TranscriptionProviderError,
  isTranscriptionProviderError,
} from "../ProviderError";
import { buildValidation } from "../TranscriptionProvider";

describe("TranscriptionProviderError", () => {
  it("captures the typed fields and defaults transient/licenseRelated to false", () => {
    const error = new TranscriptionProviderError("boom", {
      code: "HTTP_ERROR",
      status: 400,
      providerId: "custom",
      endpoint: "https://x",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TranscriptionProviderError");
    expect(error.message).toBe("boom");
    expect(error.code).toBe("HTTP_ERROR");
    expect(error.status).toBe(400);
    expect(error.transient).toBe(false);
    expect(error.licenseRelated).toBe(false);
    expect(error.providerId).toBe("custom");
  });

  it("preserves explicit transient / retryInMs / licenseRelated", () => {
    const error = new TranscriptionProviderError("rate limited", {
      code: "RATE_LIMITED",
      status: 429,
      transient: true,
      retryInMs: 5_000,
    });
    expect(error.transient).toBe(true);
    expect(error.retryInMs).toBe(5_000);

    const license = new TranscriptionProviderError("unauthorized", {
      code: "LICENSE_INVALID",
      status: 401,
      licenseRelated: true,
    });
    expect(license.licenseRelated).toBe(true);
  });

  it("is recognized by the type guard and rejects other values", () => {
    const error = new TranscriptionProviderError("x", { code: "NETWORK_ERROR" });
    expect(isTranscriptionProviderError(error)).toBe(true);
    expect(isTranscriptionProviderError(new Error("plain"))).toBe(false);
    expect(isTranscriptionProviderError(null)).toBe(false);
    expect(isTranscriptionProviderError({ code: "NETWORK_ERROR" })).toBe(false);
  });
});

describe("buildValidation", () => {
  it("is ok only when there are no errors", () => {
    expect(buildValidation()).toEqual({ ok: true, errors: [], warnings: [] });
    expect(buildValidation([], ["heads up"])).toEqual({ ok: true, errors: [], warnings: ["heads up"] });
    expect(buildValidation(["bad url"])).toEqual({ ok: false, errors: ["bad url"], warnings: [] });
  });
});
