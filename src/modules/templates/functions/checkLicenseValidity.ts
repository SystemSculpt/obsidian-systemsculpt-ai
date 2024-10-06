import { TemplatesModule } from "../TemplatesModule";
import { requestUrl } from "obsidian";
import { showCustomNotice } from "../../../modals";

let attemptCount = 0;
let lastAttemptTime = 0;

export async function checkLicenseValidity(
  plugin: TemplatesModule,
  showNotice: boolean = false,
): Promise<boolean> {
  const licenseKey = plugin.settings.licenseKey;

  if (!licenseKey || !licenseKey.includes("-") || licenseKey.includes(" ")) {
    if (showNotice) {
      showCustomNotice(
        "Invalid license key. Please enter a valid license key.",
        5000,
      );
    }
    return false;
  }

  const currentTime = Date.now();
  if (currentTime - lastAttemptTime > 3600000) {
    attemptCount = 0;
    lastAttemptTime = currentTime;
  } else if (attemptCount >= 25) {
    if (showNotice) {
      showCustomNotice(
        "You have exceeded the maximum number of attempts. Please try again later.",
        5000,
      );
    }
    return false;
  }

  try {
    const response = await requestUrl({
      url: "https://license.systemsculpt.com/check-license",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ licenseKey }),
    });

    if (response.status === 200) {
      const data = response.json;
      attemptCount = 0;
      return data.valid;
    } else if (response.status === 403) {
      if (showNotice) {
        showCustomNotice(
          "Invalid license key. Please enter a valid license key.",
          5000,
        );
      }
      attemptCount++;
      return false;
    } else if (response.status === 429) {
      if (showNotice) {
        showCustomNotice("Too many requests. Please try again later.", 5000);
      }
      return false;
    } else {
      throw new Error("Server error");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("429")) {
      if (showNotice) {
        showCustomNotice("Too many requests. Please try again later.", 5000);
      }
    } else {
      if (showNotice) {
        showCustomNotice(
          "An error occurred while checking the license key. Please try again later.",
          5000,
        );
      }
    }
    throw error;
  }
}
