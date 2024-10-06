import { BrainModule } from "../BrainModule";
import { showCustomNotice } from "../../../modals";

export async function checkForUpdate(plugin: BrainModule): Promise<void> {
  try {
    const response = await fetch(
      "https://api.github.com/repos/systemsculpt/obsidian-systemsculpt-ai/releases",
    );
    const releases = await response.json();

    const latestRelease = releases[0];
    const latestVersion = latestRelease.tag_name;

    const currentVersion = plugin.plugin.manifest.version;

    if (currentVersion !== latestVersion) {
      showCustomNotice(
        `A new version of SystemSculpt AI (${latestVersion}) is available. Please update the plugin through Community Plugins to get the latest features, fixes, and improvements.`,
        10000,
      );
    }
  } catch (error) {}
}
