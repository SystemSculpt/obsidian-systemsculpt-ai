import { API_BASE_URL } from "../../constants/api";
import { normalizeApiUrl, resolveSystemSculptApiBaseUrl, CACHE_BUSTER } from "../urlHelpers";

describe("normalizeApiUrl", () => {
  it("returns empty string for empty input", () => {
    expect(normalizeApiUrl("")).toBe("");
  });

  it("returns falsy for null input", () => {
    expect(normalizeApiUrl(null as any)).toBeFalsy();
  });

  it("adds /api/v1 to bare URL", () => {
    const result = normalizeApiUrl("https://example.com");
    expect(result).toBe("https://example.com/api/v1");
  });

  it("preserves existing /api/v1 suffix", () => {
    const result = normalizeApiUrl("https://example.com/api/v1");
    expect(result).toBe("https://example.com/api/v1");
  });

  it("adds /v1 to URL ending with /api", () => {
    const result = normalizeApiUrl("https://example.com/api");
    expect(result).toBe("https://example.com/api/v1");
  });

  it("handles trailing slashes", () => {
    const result = normalizeApiUrl("https://example.com/");
    expect(result).toBe("https://example.com/api/v1");
  });

  it("handles URL with port", () => {
    const result = normalizeApiUrl("https://example.com:8080");
    expect(result).toBe("https://example.com:8080/api/v1");
  });

  it("handles localhost URL", () => {
    const result = normalizeApiUrl("http://localhost:3000");
    expect(result).toBe("http://localhost:3000/api/v1");
  });

  it("handles invalid URL with fallback", () => {
    const result = normalizeApiUrl("not-a-valid-url");
    expect(result).toBe("not-a-valid-url/api/v1");
  });

  it("preserves invalid URL ending with /api/v1", () => {
    const result = normalizeApiUrl("not-a-valid-url/api/v1");
    expect(result).toBe("not-a-valid-url/api/v1");
  });

  it("adds /v1 for invalid URL ending with /api", () => {
    const result = normalizeApiUrl("not-a-valid-url/api");
    expect(result).toBe("not-a-valid-url/api/v1");
  });
});

describe("resolveSystemSculptApiBaseUrl", () => {
  it("returns API base when server url is empty", () => {
    expect(resolveSystemSculptApiBaseUrl(""))
      .toBe(API_BASE_URL);
    expect(resolveSystemSculptApiBaseUrl(undefined))
      .toBe(API_BASE_URL);
  });

  it("normalizes explicit API base urls", () => {
    const explicit = "https://api.systemsculpt.com/api/v1";
    expect(resolveSystemSculptApiBaseUrl(explicit)).toBe(explicit);
    const withTrailingSlash = "https://api.systemsculpt.com/";
    expect(resolveSystemSculptApiBaseUrl(withTrailingSlash)).toBe(explicit);
    const alreadyHasTrailingApi = "https://api.systemsculpt.com/api/v1/";
    expect(resolveSystemSculptApiBaseUrl(alreadyHasTrailingApi)).toBe(explicit);
    const apiOnly = "https://api.systemsculpt.com/api";
    expect(resolveSystemSculptApiBaseUrl(apiOnly)).toBe(explicit);
  });

  it("converts marketing domain to API subdomain", () => {
    expect(resolveSystemSculptApiBaseUrl("https://systemsculpt.com"))
      .toBe("https://api.systemsculpt.com/api/v1");
    expect(resolveSystemSculptApiBaseUrl("https://www.systemsculpt.com"))
      .toBe("https://api.systemsculpt.com/api/v1");
  });

  it("preserves custom hosts", () => {
    expect(resolveSystemSculptApiBaseUrl("http://localhost:3001"))
      .toBe("http://localhost:3001/api/v1");
    expect(resolveSystemSculptApiBaseUrl("https://self-hosted.example.com/service"))
      .toBe(normalizeApiUrl("https://self-hosted.example.com/service"));
  });

  it("returns default for invalid URL", () => {
    expect(resolveSystemSculptApiBaseUrl("not-a-url")).toBe(API_BASE_URL);
  });

  it("trims whitespace from input", () => {
    expect(resolveSystemSculptApiBaseUrl("  https://custom.example.com  "))
      .toBe("https://custom.example.com/api/v1");
  });
});

describe("CACHE_BUSTER", () => {
  describe("shouldApply", () => {
    it("returns true for license validation endpoint", () => {
      expect(CACHE_BUSTER.shouldApply("/license/validate")).toBe(true);
      expect(CACHE_BUSTER.shouldApply("https://api.example.com/license/validate")).toBe(true);
    });

    it("returns false for other endpoints", () => {
      expect(CACHE_BUSTER.shouldApply("/models")).toBe(false);
      expect(CACHE_BUSTER.shouldApply("/api/v1/chat")).toBe(false);
      expect(CACHE_BUSTER.shouldApply("https://api.example.com/credits")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(CACHE_BUSTER.shouldApply("")).toBe(false);
    });
  });

  describe("generate", () => {
    it("returns timestamp-based cache buster", () => {
      const result = CACHE_BUSTER.generate();
      expect(result).toMatch(/^_t=\d+$/);
    });
  });

  describe("apply", () => {
    it("adds cache buster to license validation URL", () => {
      const result = CACHE_BUSTER.apply("https://api.example.com/license/validate");
      expect(result).toMatch(/^https:\/\/api\.example\.com\/license\/validate\?_t=\d+$/);
    });

    it("adds cache buster with & for URLs with existing query params", () => {
      const result = CACHE_BUSTER.apply("https://api.example.com/license/validate?key=123");
      expect(result).toMatch(/^https:\/\/api\.example\.com\/license\/validate\?key=123&_t=\d+$/);
    });

    it("does not add cache buster to non-license endpoints", () => {
      const url = "https://api.example.com/models";
      const result = CACHE_BUSTER.apply(url);
      expect(result).toBe(url);
    });
  });
});
