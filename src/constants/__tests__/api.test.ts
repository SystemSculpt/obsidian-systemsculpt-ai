/** @jest-environment node */
import {
  API_BASE_URL,
  IS_DEVELOPMENT_BUILD,
  SYSTEMSCULPT_API_ENDPOINTS,
  SYSTEMSCULPT_API_HEADERS,
} from "../api";

describe("managed API constants", () => {
  it("defaults define-less test hosts to the canonical production base", () => {
    // Real bundles always carry the __SYSTEMSCULPT_API_BASE_URL__ define; the
    // per-route lock (release => canonical, non-release => anything else) is
    // enforced by scripts/plugin-build-options.mjs and the artifact gate in
    // scripts/plugin-artifacts.mjs, both covered by test:release-script.
    expect(API_BASE_URL).toBe("https://systemsculpt.com/api/plugin");
    expect(IS_DEVELOPMENT_BUILD).toBe(false);
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
