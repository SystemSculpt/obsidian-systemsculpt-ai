/**
 * @jest-environment node
 */

import {
  decodeCreditsBalance,
  normalizeCreditsCheckoutUrl,
} from "../SystemSculptService";

const creditsBalancePayload = {
  included_remaining: 0,
  add_on_remaining: 0,
  total_remaining: 0,
  included_per_month: 0,
  usage_class: "master_auth",
  cycle_anchor_at: "2026-07-01T00:00:00.000Z",
  cycle_started_at: "2026-07-01T00:00:00.000Z",
  cycle_ends_at: "2026-08-01T00:00:00.000Z",
  turn_in_flight_until: null,
  purchase_url: null,
};

describe("decodeCreditsBalance", () => {
  it.each(["master_auth", "customer"] as const)(
    "preserves the exact %s usage identity",
    (usageClass) => {
      expect(decodeCreditsBalance({
        ...creditsBalancePayload,
        usage_class: usageClass,
      })).toMatchObject({
        usageClass,
        totalRemaining: 0,
      });
    },
  );

  it.each([
    ["missing", undefined],
    ["unknown", "internal"],
  ])("fails closed for %s usage identity", (_label, usageClass) => {
    const payload = {
      ...creditsBalancePayload,
      usage_class: usageClass,
    };
    if (usageClass === undefined) {
      delete (payload as Partial<typeof payload>).usage_class;
    }

    expect(() => decodeCreditsBalance(payload)).toThrow(
      "Unable to read credits balance.",
    );
  });
});

describe("normalizeCreditsCheckoutUrl", () => {
  it("accepts canonical relative paths and owned https destinations", () => {
    expect(normalizeCreditsCheckoutUrl("/checkout?resourceId=abc123")).toBe(
      "https://systemsculpt.com/checkout?resourceId=abc123"
    );
    expect(normalizeCreditsCheckoutUrl("https://systemsculpt.com/pricing")).toBe(
      "https://systemsculpt.com/pricing"
    );
    expect(normalizeCreditsCheckoutUrl("https://www.systemsculpt.com/pricing")).toBe(
      "https://www.systemsculpt.com/pricing"
    );
  });

  it.each([
    "http://systemsculpt.com/pricing",
    "https://systemsculpt.com:444/pricing",
    "https://www.systemsculpt.com:444/pricing",
    "https://api.systemsculpt.com/pricing",
    "https://systemsculpt.com.evil.example/pricing",
    "https://evil.example/pricing",
    "https://user:pass@systemsculpt.com/pricing",
    "//evil.example/pricing",
    "/\\\\evil.example/pricing",
    "javascript:alert(1)",
    "data:text/html,owned",
    "pricing",
    "not a url",
  ])("rejects unsafe checkout destination %s", (value) => {
    expect(normalizeCreditsCheckoutUrl(value)).toBeNull();
  });
});
