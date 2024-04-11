import { UpdateModule } from '../UpdateModule';
import { Notice } from 'obsidian';
import { showCustomNotice } from '../../../modals';

export async function checkForUpdate(plugin: UpdateModule): Promise<void> {
  try {
    const response = await fetch(
      'https://api.github.com/repos/SystemSculpt/obsidian-systemsculpt-ai/releases/latest'
    );
    const data = await response.json();
    const latestRelease = data.tag_name;

    if (latestRelease !== plugin.plugin.manifest.version) {
      showCustomNotice(
        `SystemSculpt AI: New version ${latestRelease} is available! Please update the plugin.`
      );
      plugin.updateAvailable = true;
    }
  } catch (error) {
    console.log(error);
  }
}
