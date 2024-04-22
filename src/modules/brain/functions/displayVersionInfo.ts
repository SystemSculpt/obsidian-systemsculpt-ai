import { requestUrl } from 'obsidian';

export async function displayVersionInfo(
  containerEl: HTMLElement,
  plugin: any
): Promise<void> {
  const versionInfoContainer = containerEl.createDiv({
    cls: 'version-info-container',
  });
  const versionInfoText = versionInfoContainer.createEl('span', {
    cls: 'version-info-text',
    text: 'Checking version...',
  });

  const installedVersion = plugin.plugin.manifest.version;
  const latestVersion = await getLatestVersion();

  if (installedVersion === latestVersion) {
    versionInfoText.setText(
      'You are running the latest SystemSculpt AI release.'
    );
    versionInfoText.addClass('up-to-date');
  } else {
    versionInfoText.setText(
      'There is a new SystemSculpt AI release available, please update!'
    );
    versionInfoText.addClass('outdated');
  }
}

async function getLatestVersion(): Promise<string> {
  // Fetch the latest release version from GitHub
  const response = await requestUrl({
    url: 'https://api.github.com/repos/systemsculpt/obsidian-systemsculpt-ai/releases/latest',
  });
  const data = await response.json;
  return data.tag_name;
}
