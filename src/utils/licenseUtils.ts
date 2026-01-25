import { SystemSculptSettings } from "../types";
import { Notice } from "obsidian";

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

export function verifyPremiumAccess(
  settings: SystemSculptSettings, 
  showNotice: boolean = true
): boolean {
  const status = checkPremiumUserStatus(settings);

  if (!status.isPremium) {
    if (showNotice) {
      new Notice("Premium Pro license required for this feature");
    }
    return false;
  }

  return true;
}