import { SystemSculptSettings } from "../types";

export interface PremiumUserStatus {
  isPremium: boolean;
  displayName: string;
  greeting?: string;
}

export function checkPremiumUserStatus(settings: SystemSculptSettings): PremiumUserStatus {
  const isPremium = settings.licenseValid === true;
  const displayName = settings.displayName || settings.userName || settings.userEmail || "User";

  let status: PremiumUserStatus = {
    isPremium,
    displayName,
  };

  // Generate personalized greeting for premium users
  if (isPremium && displayName.toLowerCase().includes("daughter")) {
    status.greeting = `Welcome back, cherished family member ${displayName}! Your premium pro access is active.`;
  } else if (isPremium) {
    status.greeting = `Welcome ${displayName}! Premium Pro active`;
  }

  return status;
}
