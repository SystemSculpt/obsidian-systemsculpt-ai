import { TemplatesModule } from '../TemplatesModule';
import { requestUrl } from 'obsidian';

export async function checkLicenseValidity(
  plugin: TemplatesModule
): Promise<boolean> {
  try {
    const response = await requestUrl({
      url: 'https://license.systemsculpt.com/check-license',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ licenseKey: plugin.settings.licenseKey }),
    });

    if (response.status === 200) {
      const data = response.json;
      return data.valid;
    } else {
      console.error('Error checking license validity:', response.text);
      throw new Error('Server error');
    }
  } catch (error) {
    console.error('Error checking license validity:', error);
    throw error;
  }
}
