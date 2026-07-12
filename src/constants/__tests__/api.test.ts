/** @jest-environment node */
import {
  API_BASE_URL,
  PRODUCTION_API_BASE_URL,
  PRODUCTION_WEBSITE_API_BASE_URL,
  WEBSITE_API_BASE_URL,
  IS_DEVELOPMENT_BUILD,
  SYSTEMSCULPT_API_ENDPOINTS,
  SYSTEMSCULPT_API_HEADERS,
} from "../api";

describe("managed API constants", () => {
  it("defaults tests to the production compiled base", () => {
    expect(API_BASE_URL).toBe(PRODUCTION_API_BASE_URL);
    expect(WEBSITE_API_BASE_URL).toBe(PRODUCTION_WEBSITE_API_BASE_URL);
    expect(IS_DEVELOPMENT_BUILD).toBe(false);
  });

  it("exposes only current license and credits endpoints", () => {
    expect(SYSTEMSCULPT_API_ENDPOINTS).toEqual({
      LICENSE: { VALIDATE: expect.any(Function) },
      CREDITS: { BALANCE: "/credits/balance", USAGE: "/credits/usage" },
    });
    expect(SYSTEMSCULPT_API_ENDPOINTS.LICENSE.VALIDATE()).toBe("/license/validate");
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
