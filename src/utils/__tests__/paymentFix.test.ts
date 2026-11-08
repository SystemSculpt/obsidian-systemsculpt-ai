/**
 * @jest-environment node
 */
import type { CreditsBalanceSnapshot } from "../../services/credits/HostedCreditsClient";
import { isStarterBalance, needsPaymentFix } from "../licenseUtils";

jest.mock("../externalUrl", () => ({ openExternalUrl: jest.fn(async () => true) }));
import { openExternalUrl } from "../externalUrl";
import { openBillingPortal } from "../billingPortal";

const balance = (extra: Partial<CreditsBalanceSnapshot>): CreditsBalanceSnapshot => ({
  includedRemaining: 0, addOnRemaining: 0, totalRemaining: 0, includedPerMonth: 0,
  includedCreditsEntitled: false, usageClass: "customer",
  cycleEndsAt: "", cycleStartedAt: "", cycleAnchorAt: "", turnInFlightUntil: null, purchaseUrl: null,
  ...extra,
});

// T-5348: a failed renewal earns no included credits, like a starter, but must
// fix its card on the existing plan instead of buying a second Monthly.
describe("past-due versus starter", () => {
  it.each([
    ["starter", null, true, false],
    ["starter on an older server", undefined, true, false],
    ["past-due Monthly", "past_due", false, true],
    ["unpaid Monthly", "unpaid", false, true],
    ["active plan", "active", false, false],
  ] as const)("%s: starter=%s, needs card fix=%s", (_scenario, status, starter, fix) => {
    const value = balance(status === undefined ? {} : { subscriptionStatus: status });
    expect(isStarterBalance(value)).toBe(starter);
    expect(needsPaymentFix(value)).toBe(fix);
  });
});

describe("openBillingPortal", () => {
  beforeEach(() => jest.clearAllMocks());

  it("opens the account's own portal link", async () => {
    await openBillingPortal({ createBillingPortalLink: async () => "https://billing.stripe.com/p/session/test_1" });
    expect(openExternalUrl).toHaveBeenCalledWith("https://billing.stripe.com/p/session/test_1", undefined);
  });

  it("falls back to the website Billing page when the link fails", async () => {
    await openBillingPortal({ createBillingPortalLink: async () => { throw new Error("offline"); } });
    expect(String((openExternalUrl as jest.Mock).mock.calls[0][0])).toMatch(/^https:\/\/systemsculpt\.com\/dashboard\/billing\?/);
  });
});
