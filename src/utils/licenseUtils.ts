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
