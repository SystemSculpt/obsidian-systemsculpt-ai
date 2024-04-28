import { TemplatesModule } from '../TemplatesModule';
import { normalizePath, requestUrl, TFile, TFolder } from 'obsidian';
import { showCustomNotice } from '../../../modals';

async function createFolderIfNotExists(
  vault: any,
  folderPath: string
): Promise<void> {
  const normalizedPath = normalizePath(folderPath);
  const folder = vault.getAbstractFileByPath(normalizedPath);

  if (!folder) {
    await vault.createFolder(normalizedPath);
  }
}

async function downloadFile(
  plugin: TemplatesModule,
  filePath: string,
  fileContent: string
): Promise<void> {
  const { vault } = plugin.plugin.app;
  let file = vault.getAbstractFileByPath(filePath);
  if (file instanceof TFile) {
    await vault.modify(file, fileContent); // Modify existing file with new content
  } else {
    file = await vault.create(filePath, fileContent); // Create new file if it doesn't exist
  }
}

export async function downloadTemplatesFromServer(
  plugin: TemplatesModule
): Promise<void> {
  try {
    // Check if the license key is empty
    const licenseKey = plugin.settings.licenseKey.trim();
    if (!licenseKey) {
      console.log(
        'License key is empty. Skipping template version check and update.'
      );
      return;
    }

    // Fetch the latest templates version from the server
    const versionResponse = await requestUrl({
      url: 'https://license.systemsculpt.com/templates-version',
      method: 'GET',
    });

    const latestVersion = versionResponse.json.version;

    // Proceed only if the local version is different from the server version
    if (plugin.settings.templatesVersion !== latestVersion) {
      const response = await requestUrl({
        url: 'https://license.systemsculpt.com/templates',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${plugin.settings.licenseKey}`,
        },
      });

      if (response.status === 401) {
        showCustomNotice(
          'Invalid license key. Please enter a valid license key to sync templates.'
        );
        return;
      }

      const templates = response.json;
      const userDefinedPath = plugin.settings.templatesPath;
      const ssSyncsPath = normalizePath(`${userDefinedPath}/SS-Syncs`);

      await createFolderIfNotExists(plugin.plugin.app.vault, ssSyncsPath);

      for (const template of templates) {
        const fullPath = normalizePath(`${ssSyncsPath}/${template.path}`);

        if (template.type === 'directory') {
          await createFolderIfNotExists(plugin.plugin.app.vault, fullPath);
        } else if (template.type === 'file') {
          await downloadFile(plugin, fullPath, template.content);
        }
      }

      // Update the local templates version and save settings
      plugin.settings.templatesVersion = latestVersion;
      await plugin.saveSettings();

      showCustomNotice(
        'SS-Sync Templates downloaded successfully! Thanks for your support on Patreon!'
      );
    } else {
      showCustomNotice('You already have the latest version of the templates.');
    }
  } catch (error) {
    console.error('Error downloading templates:', error);
    showCustomNotice(
      "Failed to download templates. Please check your SystemSculpt Patreon's license key and try again."
    );
  }
}
