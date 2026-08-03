/** @jest-environment node */
import {
  API_BASE_URL,
  PRODUCTION_API_BASE_URL,
  IS_DEVELOPMENT_BUILD,
  selectCompiledApiBaseUrl,
  SYSTEMSCULPT_API_ENDPOINTS,
  SYSTEMSCULPT_API_HEADERS,
} from "../api";

describe("managed API constants", () => {
  it("defaults tests to the production compiled base", () => {
    expect(API_BASE_URL).toBe(PRODUCTION_API_BASE_URL);
    expect(IS_DEVELOPMENT_BUILD).toBe(false);
  });

  it("locks release selection to the production endpoint", () => {
    expect(selectCompiledApiBaseUrl(undefined, true)).toBe(PRODUCTION_API_BASE_URL);
    expect(selectCompiledApiBaseUrl(PRODUCTION_API_BASE_URL, true))
      .toBe(PRODUCTION_API_BASE_URL);
    expect(() => selectCompiledApiBaseUrl(
      "https://staging.systemsculpt.com/api/plugin",
      true,
    )).toThrow("Release builds require the production SystemSculpt API");
    expect(() => selectCompiledApiBaseUrl(
      "http://127.0.0.1:8787/api/plugin",
      true,
    )).toThrow("Release builds require the production SystemSculpt API");
  });

  it("requires an explicit valid endpoint for non-release builds", () => {
    expect(selectCompiledApiBaseUrl(
      "http://127.0.0.1:8787/api/plugin/",
      false,
    )).toBe("http://127.0.0.1:8787/api/plugin");
    expect(() => selectCompiledApiBaseUrl(undefined, false))
      .toThrow("Development builds require an explicit SystemSculpt API target");
    expect(() => selectCompiledApiBaseUrl("https://example.com/api/plugin?debug=1", false))
      .toThrow("The compiled SystemSculpt API base is invalid");
  });

  it("exposes only current license and credits endpoints", () => {
    expect(SYSTEMSCULPT_API_ENDPOINTS).toEqual({
      CREDITS: { BALANCE: "/credits/balance", USAGE: "/credits/usage" },
    });
  });

  it("adds the managed license key to standard headers", () => {
    expect(SYSTEMSCULPT_API_HEADERS.WITH_LICENSE("license-key")).toMatchObject({
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-SystemSculpt-Client": "obsidian-plugin",
      "x-license-key": "license-key",
    });
  });
});
