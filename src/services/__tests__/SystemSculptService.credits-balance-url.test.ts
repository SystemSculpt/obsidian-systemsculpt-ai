/**
 * @jest-environment node
 */

import { ERROR_CODES } from "../../utils/errors";
import {
  decodeCreditsBalance,
  normalizeCreditsCheckoutUrl,
  parseCreditsBalanceServerTiming,
  SystemSculptService,
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
  it.each([null, [], "balance", 0])("rejects a non-record balance (%j)", (payload) => {
    expect(() => decodeCreditsBalance(payload)).toThrow(expect.objectContaining({
      code: ERROR_CODES.INVALID_RESPONSE,
      statusCode: 502,
    }));
  });

  it.each([
    ["negative credits", { included_remaining: -1 }],
    ["fractional credits", { add_on_remaining: 0.5 }],
    ["string credits", { total_remaining: "0" }],
    ["non-finite credits", { included_per_month: Infinity }],
    ["unsafe credits", { included_remaining: Number.MAX_SAFE_INTEGER + 1 }],
    ["mismatched total", { total_remaining: 1 }],
    ["overflowed sum", { included_remaining: Number.MAX_SAFE_INTEGER, add_on_remaining: 1 }],
    ["non-string timestamp", { cycle_anchor_at: 0 }],
    ["blank timestamp", { cycle_started_at: " " }],
    ["invalid timestamp", { cycle_ends_at: "not-a-date" }],
    ["invalid active turn timestamp", { turn_in_flight_until: "not-a-date" }],
  ])("does not display a fabricated balance for %s", (_label, overrides) => {
    expect(() => decodeCreditsBalance({ ...creditsBalancePayload, ...overrides })).toThrow(
      "Unable to read credits balance.",
    );
  });

  const annualOffer = {
    amount_saved_cents: 2000,
    percent_saved: 20,
    annual_price_cents: 8000,
    monthly_equivalent_annual_cents: 10000,
    checkout_path: "/checkout?plan=annual",
  };

  it("preserves a valid annual offer and normalizes billing-cycle and active-turn metadata", () => {
    expect(decodeCreditsBalance({
      ...creditsBalancePayload,
      billing_cycle: " Monthly ",
      cycle_started_at: " 2026-07-01T00:00:00.000Z ",
      turn_in_flight_until: " 2026-07-15T12:00:00.000Z ",
      annual_upgrade_offer: annualOffer,
    })).toMatchObject({
      billingCycle: "monthly",
      cycleStartedAt: "2026-07-01T00:00:00.000Z",
      turnInFlightUntil: "2026-07-15T12:00:00.000Z",
      annualUpgradeOffer: {
        amountSavedCents: 2000,
        percentSaved: 20,
        annualPriceCents: 8000,
        monthlyEquivalentAnnualCents: 10000,
        checkoutUrl: "https://systemsculpt.com/checkout?plan=annual",
      },
    });
  });

  it.each([
    [],
    { ...annualOffer, amount_saved_cents: 0 },
    { ...annualOffer, percent_saved: 1.5 },
    { ...annualOffer, annual_price_cents: "8000" },
    { ...annualOffer, monthly_equivalent_annual_cents: 8000 },
    { ...annualOffer, checkout_path: "https://example.com/checkout" },
  ])("drops an invalid offer without discarding the usable balance (%j)", (offer) => {
    expect(decodeCreditsBalance({ ...creditsBalancePayload, annual_upgrade_offer: offer })).toMatchObject({
      totalRemaining: 0,
      annualUpgradeOffer: null,
    });
  });

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

  it.each([true, false, undefined, null, "false"])("reads only explicit included-credit entitlement (%s)", (entitled) => {
    expect(decodeCreditsBalance({
      ...creditsBalancePayload,
      included_credits_entitled: entitled,
    }).includedCreditsEntitled).toBe(typeof entitled === "boolean" ? entitled : undefined);
  });

  it("reads whether the account has used the iOS app, false from older servers", () => {
    expect(decodeCreditsBalance(creditsBalancePayload).iosAppLinked).toBe(false);
    expect(decodeCreditsBalance({ ...creditsBalancePayload, ios_app_linked: false }).iosAppLinked).toBe(false);
    expect(decodeCreditsBalance({ ...creditsBalancePayload, ios_app_linked: "yes" }).iosAppLinked).toBe(false);
    expect(decodeCreditsBalance({ ...creditsBalancePayload, ios_app_linked: true }).iosAppLinked).toBe(true);
  });

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

describe("credits requests", () => {
  afterEach(() => SystemSculptService.clearInstance());

  it("forward the caller's signal to the balance and usage requests", async () => {
    const service = SystemSculptService.getInstance({ settings: { licenseKey: "license" }, app: {} } as never);
    const request = jest.fn(async (input: { url: string }) => new Response(JSON.stringify(
      input.url.includes("usage") ? { items: [], next_before: null } : creditsBalancePayload,
    ), { status: 200, headers: { "content-type": "application/json" } }));
    (service as unknown as { requestClient: { request: typeof request } }).requestClient.request = request;
    const controller = new AbortController();

    await service.getCreditsBalance({ signal: controller.signal });
    await service.getCreditsUsage({ limit: 5, signal: controller.signal });

    expect(request).toHaveBeenCalledTimes(2);
    for (const [input] of request.mock.calls) {
      expect((input as { signal?: AbortSignal }).signal).toBe(controller.signal);
    }
  });
});

describe("parseCreditsBalanceServerTiming", () => {
  it("extracts only bounded credits-route phase durations", () => {
    expect(parseCreditsBalanceServerTiming(
      "auth;dur=5.1239, rate-limit;dur=3, balance-store;dur=8.25, total;dur=25",
    )).toEqual({
      authMs: 5.124,
      rateLimitMs: 3,
      balanceStoreMs: 8.25,
      totalMs: 25,
    });
  });

  it("drops unknown, duplicate, negative, non-finite, and oversized values", () => {
    expect(parseCreditsBalanceServerTiming(
      "provider;dur=999, auth;dur=-1, total;dur=Infinity, total;dur=7, total;dur=8",
    )).toEqual({ totalMs: 7 });
    expect(parseCreditsBalanceServerTiming("x".repeat(1_025))).toBeUndefined();
    expect(parseCreditsBalanceServerTiming(null)).toBeUndefined();
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
