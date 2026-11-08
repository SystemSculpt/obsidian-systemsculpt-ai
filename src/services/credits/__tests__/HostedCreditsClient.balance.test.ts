/**
 * @jest-environment node
 */
import { ERROR_CODES } from "../../../utils/errors";
import { HostedCreditsClient } from "../HostedCreditsClient";

const balancePayload = {
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

function createClient(payload: unknown, serverTiming?: string) {
  // Keep non-JSON numbers intact so validation, not JSON.stringify, rejects them.
  const response = new Response(null, {
    headers: serverTiming === undefined ? {} : { "server-timing": serverTiming },
  });
  response.json = async () => payload;
  const request = jest.fn(async () => response);
  const credits = new HostedCreditsClient({
    baseUrl: "https://systemsculpt.com/api/plugin",
    licenseKey: () => "license_for_test",
    requestClient: { request },
  });
  return { credits, request };
}

async function readBalance(payload: unknown) {
  return createClient(payload).credits.readBalance();
}

describe("HostedCreditsClient balance wire", () => {
  it.each(["past_due", "unpaid", "active", "trialing", null] as const)(
    "keeps the plan status %j (T-5348)", async (status) => {
      await expect(readBalance({ ...balancePayload, subscription_status: status }))
        .resolves.toMatchObject({ subscriptionStatus: status });
    },
  );

  it("leaves the plan status unknown for an older server or an unknown value", async () => {
    await expect(readBalance(balancePayload)).resolves.not.toHaveProperty("subscriptionStatus");
    await expect(readBalance({ ...balancePayload, subscription_status: "paused" }))
      .resolves.not.toHaveProperty("subscriptionStatus");
  });

  it.each([null, [], "balance", 0])("rejects a non-record balance (%j)", async (payload) => {
    await expect(readBalance(payload)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_RESPONSE,
      statusCode: 502,
    });
  });

  it.each([
    ["negative credits", { included_per_month: -1 }],
    ["fractional credits", { included_per_month: 0.5 }],
    ["string credits", { included_per_month: "0" }],
    ["non-finite credits", { included_per_month: Infinity }],
    ["unsafe credits", { included_per_month: Number.MAX_SAFE_INTEGER + 1 }],
    ["mismatched total", { total_remaining: 1 }],
    ["overflowed sum", { included_remaining: Number.MAX_SAFE_INTEGER, add_on_remaining: 1 }],
    ["non-string timestamp", { cycle_anchor_at: 0 }],
    ["blank timestamp", { cycle_started_at: " " }],
    ["invalid timestamp", { cycle_ends_at: "not-a-date" }],
    ["invalid active turn timestamp", { turn_in_flight_until: "not-a-date" }],
  ])("does not display a fabricated balance for %s", async (_label, overrides) => {
    await expect(readBalance({ ...balancePayload, ...overrides })).rejects.toThrow("Unable to read credits balance.");
  });

  const annualOffer = {
    amount_saved_cents: 2000,
    percent_saved: 20,
    annual_price_cents: 8000,
    monthly_equivalent_annual_cents: 10000,
    checkout_path: "/checkout?plan=annual",
  };

  it("preserves a valid annual offer and normalizes billing-cycle and active-turn metadata", async () => {
    await expect(readBalance({
      ...balancePayload,
      billing_cycle: " Monthly ",
      cycle_started_at: " 2026-07-01T00:00:00.000Z ",
      turn_in_flight_until: " 2026-07-15T12:00:00.000Z ",
      annual_upgrade_offer: annualOffer,
    })).resolves.toMatchObject({
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
  ])("drops an invalid offer without discarding the usable balance (%j)", async (offer) => {
    await expect(readBalance({
      ...balancePayload,
      included_remaining: 10,
      add_on_remaining: 5,
      total_remaining: 15,
      available_unreserved: 15,
      annual_upgrade_offer: offer,
    })).resolves.toMatchObject({
      includedRemaining: 10,
      addOnRemaining: 5,
      totalRemaining: 15,
      annualUpgradeOffer: null,
    });
  });

  it.each(["master_auth", "customer"] as const)("preserves the exact %s usage identity", async (usageClass) => {
    await expect(readBalance({ ...balancePayload, usage_class: usageClass }))
      .resolves.toMatchObject({ usageClass, totalRemaining: 0 });
  });

  it.each([true, false, undefined, null, "false"])("reads only explicit included-credit entitlement (%s)", async (entitled) => {
    const balance = await readBalance({ ...balancePayload, included_credits_entitled: entitled });
    expect(balance.includedCreditsEntitled).toBe(typeof entitled === "boolean" ? entitled : undefined);
  });

  it.each([undefined, false, "yes", true])("reads only explicit iOS account linkage (%s)", async (linked) => {
    await expect(readBalance({ ...balancePayload, ios_app_linked: linked }))
      .resolves.toMatchObject({ iosAppLinked: linked === true });
  });

  it("preserves held and spendable balances while accepting the legacy gross-only shape", async () => {
    await expect(readBalance({
      ...balancePayload,
      included_remaining: 10,
      total_remaining: 10,
      held_in_flight: 7,
      available_unreserved: 3,
      usage_class: "customer",
    })).resolves.toMatchObject({ totalRemaining: 10, heldInFlight: 7, availableUnreserved: 3 });

    const legacy = { ...balancePayload } as Record<string, unknown>;
    delete legacy.held_in_flight;
    delete legacy.available_unreserved;
    await expect(readBalance(legacy)).resolves.toMatchObject({
      totalRemaining: 0, heldInFlight: 0, availableUnreserved: 0,
    });
  });

  it.each([
    ["one-sided held fields", { held_in_flight: 1 }],
    ["one-sided available fields", { available_unreserved: 0 }],
    ["inconsistent spendable total", { held_in_flight: 2, available_unreserved: 9 }],
  ])("fails closed for %s", async (_label, overrides) => {
    const payload = { ...balancePayload, ...overrides } as Record<string, unknown>;
    if (!("held_in_flight" in overrides)) delete payload.held_in_flight;
    if (!("available_unreserved" in overrides)) delete payload.available_unreserved;
    await expect(readBalance(payload)).rejects.toThrow("Unable to read credits balance.");
  });

  it.each([undefined, "internal"])("fails closed for unsupported usage identity %s", async (usageClass) => {
    await expect(readBalance({ ...balancePayload, usage_class: usageClass }))
      .rejects.toThrow("Unable to read credits balance.");
  });

  it("cancels only the balance caller while forwarding usage cancellation to transport", async () => {
    const { credits, request } = createClient(balancePayload);
    const controller = new AbortController();
    const cancelled = credits.readBalance({ signal: controller.signal });
    const shared = credits.readBalance();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(shared).resolves.toMatchObject({ totalRemaining: 0 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenNthCalledWith(1, expect.not.objectContaining({ signal: controller.signal }));

    const usageController = new AbortController();
    await credits.readUsage({ limit: 5, signal: usageController.signal });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({ signal: usageController.signal }));
  });

  it.each([
    ["auth;dur=5.1239, rate-limit;dur=3, balance-store;dur=8.25, total;dur=25",
      { authMs: 5.124, rateLimitMs: 3, balanceStoreMs: 8.25, totalMs: 25 }],
    ["provider;dur=999, auth;dur=-1, total;dur=Infinity, total;dur=7, total;dur=8", { totalMs: 7 }],
    ["x".repeat(1_025), undefined],
    [undefined, undefined],
  ])("observes only bounded credits-route phase durations (%s)", async (header, serverTiming) => {
    const { credits } = createClient(balancePayload, header);
    const onObservation = jest.fn();
    await credits.readBalance({ onObservation });
    expect(onObservation).toHaveBeenCalledWith({
      transport: undefined, status: 200, ...(serverTiming ? { serverTiming } : {}),
    });
  });

  it.each([
    ["/checkout?resourceId=abc123", "https://systemsculpt.com/checkout?resourceId=abc123"],
    ["https://systemsculpt.com/pricing", "https://systemsculpt.com/pricing"],
    ["https://www.systemsculpt.com/pricing", "https://www.systemsculpt.com/pricing"],
  ])("accepts owned HTTPS checkout destination %s", async (wire, purchaseUrl) => {
    await expect(readBalance({ ...balancePayload, purchase_url: wire })).resolves.toMatchObject({ purchaseUrl });
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
  ])("rejects unsafe checkout destination %s", async (value) => {
    await expect(readBalance({ ...balancePayload, purchase_url: value }))
      .resolves.toMatchObject({ purchaseUrl: null });
  });
});
