import { UpdateModule } from '../UpdateModule';
import { requestUrl } from 'obsidian';
import { showCustomNotice } from '../../../modals';

export async function checkForUpdate(plugin: UpdateModule): Promise<void> {
  try {
    const response = await requestUrl({
      url: 'https://api.github.com/repos/SystemSculpt/obsidian-systemsculpt-ai/releases/latest',
      method: 'GET',
    });

    const data = response.json;

    if (data) {
      const latestRelease = data.tag_name;
      console.log('Latest release version:', latestRelease);

      const currentVersion = plugin.plugin.manifest.version;
      console.log(
        `Checking for updates... Current version: ${currentVersion}, Latest release: ${latestRelease}`
      );

      if (latestRelease !== currentVersion) {
        console.log(`Update available: YES`);
        showCustomNotice(
          `SystemSculpt AI: New version ${latestRelease} is available! Click "Update" in the Brain settings to update.`
        );
        plugin.updateAvailable = true;
        // Ensure the update status bar item is visible
        if (plugin.plugin.updateStatusBarItem) {
          plugin.plugin.updateStatusBarItem.style.display = 'inline-block';
        }
      } else {
        console.log(`Update available: NO`);
      }
    }
  } catch (error) {
    console.error(`Error checking for update:`, error);
  }
}
