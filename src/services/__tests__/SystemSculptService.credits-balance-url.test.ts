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
  held_in_flight: 0,
  available_unreserved: 0,
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

  it("preserves held and spendable balances while accepting the legacy gross-only shape", () => {
    expect(decodeCreditsBalance({
      ...creditsBalancePayload,
      included_remaining: 10,
      total_remaining: 10,
      held_in_flight: 7,
      available_unreserved: 3,
      usage_class: "customer",
    })).toMatchObject({
      totalRemaining: 10,
      heldInFlight: 7,
      availableUnreserved: 3,
    });

    const legacy = { ...creditsBalancePayload } as Record<string, unknown>;
    delete legacy.held_in_flight;
    delete legacy.available_unreserved;
    expect(decodeCreditsBalance(legacy)).toMatchObject({
      totalRemaining: 0,
      heldInFlight: 0,
      availableUnreserved: 0,
    });
  });

  it.each([
    ["one-sided held fields", { held_in_flight: 1 }],
    ["one-sided available fields", { available_unreserved: 0 }],
    ["inconsistent spendable total", { held_in_flight: 2, available_unreserved: 9 }],
  ])("fails closed for %s", (_label, overrides) => {
    const payload = { ...creditsBalancePayload, ...overrides } as Record<string, unknown>;
    if (!("held_in_flight" in overrides)) delete payload.held_in_flight;
    if (!("available_unreserved" in overrides)) delete payload.available_unreserved;
    expect(() => decodeCreditsBalance(payload)).toThrow("Unable to read credits balance.");
  });

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
