import { TemplatesModule } from '../TemplatesModule';
import { requestUrl } from 'obsidian';
import { showCustomNotice } from '../../../modals';

let attemptCount = 0;
let lastAttemptTime = 0;

export async function checkLicenseValidity(
  plugin: TemplatesModule,
  showNotice: boolean = false
): Promise<boolean> {
  const licenseKey = plugin.settings.licenseKey;

  // Check if the license key is empty, doesn't contain dashes, or contains spaces
  if (!licenseKey || !licenseKey.includes('-') || licenseKey.includes(' ')) {
    if (showNotice) {
      showCustomNotice(
        'Invalid license key. Please enter a valid license key.',
        5000
      );
    }
    return false;
  }

  // Check if the user has exceeded the attempt limit
  const currentTime = Date.now();
  if (currentTime - lastAttemptTime > 3600000) {
    // Reset attempt count if more than an hour has passed
    attemptCount = 0;
    lastAttemptTime = currentTime;
  } else if (attemptCount >= 25) {
    if (showNotice) {
      showCustomNotice(
        'You have exceeded the maximum number of attempts. Please try again later.',
        5000
      );
    }
    return false;
  }

  try {
    const response = await requestUrl({
      url: 'https://license.systemsculpt.com/check-license',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ licenseKey }),
    });

    if (response.status === 200) {
      const data = response.json;
      attemptCount = 0; // Reset attempt count on successful validation
      return data.valid;
    } else if (response.status === 403) {
      if (showNotice) {
        showCustomNotice(
          'Invalid license key. Please enter a valid license key.',
          5000
        );
      }
      attemptCount++; // Increment attempt count on invalid key
      return false;
    } else {
      console.error('Error checking license validity:', response.text);
      throw new Error('Server error');
    }
  } catch (error) {
    console.error('Error checking license validity:', error);
    if (showNotice) {
      showCustomNotice(
        'Your license key is invalid. Please contact Mike on Patreon or Discord to obtain a valid license key.',
        5000
      );
    }
    throw error;
  }
}
