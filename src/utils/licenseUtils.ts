import { SystemSculptSettings } from "../types";

export interface PremiumUserStatus {
  isPremium: boolean;
  displayName: string;
  greeting?: string;
}

export function checkPremiumUserStatus(settings: SystemSculptSettings): PremiumUserStatus {
  const isPremium = settings.licenseValid === true;
  const knownName = settings.displayName || settings.userName || settings.userEmail || "";
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
