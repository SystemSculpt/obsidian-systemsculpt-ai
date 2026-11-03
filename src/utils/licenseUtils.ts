import { SystemSculptSettings } from "../types";
import type { CreditsBalanceSnapshot } from "../services/SystemSculptService";

export interface PremiumUserStatus {
  isPremium: boolean;
  displayName: string;
  greeting?: string;
}

function knownNameOf(settings: SystemSculptSettings): string {
  return settings.displayName || settings.userName || settings.userEmail || "";
}

export function checkPremiumUserStatus(settings: SystemSculptSettings): PremiumUserStatus {
  const isPremium = settings.licenseValid === true;
  const knownName = knownNameOf(settings);
  const displayName = knownName || "User";

  let status: PremiumUserStatus = {
    isPremium,
    displayName,
  };

  // Generate personalized greeting for premium users
  if (isPremium && displayName.toLowerCase().includes("daughter")) {
    status.greeting = `Welcome back, cherished family member ${displayName}! Your premium pro access is active.`;
  } else if (isPremium) {
    // A license key alone carries no name, so most buyers have none here (T-4482).
    status.greeting = knownName
      ? `Welcome, ${knownName}. SystemSculpt Pro is active.`
      : "SystemSculpt Pro is active.";
  }

  return status;
}

/** A free starter account: a valid key whose plan includes no monthly credits. */
export function isStarterBalance(balance: CreditsBalanceSnapshot | null | undefined): boolean {
  return !!balance && balance.usageClass !== "master_auth" && balance.includedCreditsEntitled === false;
}

/** Under this many available credits, a starter account sees the Monthly offer (T-4520). */
export const LOW_CREDITS_OFFER_THRESHOLD = 100;
export const MONTHLY_OFFER_LINE = "$9 a month for 10,000 credits every month";

/**
 * When a starter account should see the Monthly offer: "out" with nothing left
 * to spend, "low" under 100 credits (a hosted turn costs about 22), else null.
 */
export function starterCreditsOffer(balance: CreditsBalanceSnapshot | null | undefined): "low" | "out" | null {
  if (!balance || !isStarterBalance(balance)) return null;
  const available = Math.min(balance.availableUnreserved ?? balance.totalRemaining, balance.totalRemaining);
  if (!Number.isFinite(available)) return null;
  if (available <= 0) return "out";
  return available < LOW_CREDITS_OFFER_THRESHOLD ? "low" : null;
}

/**
 * The Account row line for an active license. A valid key alone does not say
 * the plan: starter keys validate too (T-4527), so Pro is claimed only once the
 * balance shows a paid plan. An unknown balance gets a plan-neutral line; a
 * server too old to report entitlement keeps the Pro greeting.
 */
export function activeAccountLine(
  settings: SystemSculptSettings,
  balance: CreditsBalanceSnapshot | null | undefined,
  formatCredits: (value: number) => string = String,
): string {
  const knownName = knownNameOf(settings);
  if (!balance) return knownName ? `Welcome, ${knownName}.` : "License active.";
  if (isStarterBalance(balance)) {
    const left = Math.max(0, balance.availableUnreserved ?? balance.totalRemaining);
    const plan = `Free starter plan: ${formatCredits(left)} credits left.`;
    return knownName ? `Welcome, ${knownName}. ${plan}` : plan;
  }
  return checkPremiumUserStatus(settings).greeting || "Pro features enabled.";
}
