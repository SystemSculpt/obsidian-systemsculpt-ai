import { TemplatesModule } from '../TemplatesModule';
import { TFile, normalizePath, requestUrl } from 'obsidian';
import { showCustomNotice } from '../../../modals';

export async function downloadTemplatesFromServer(
  plugin: TemplatesModule
): Promise<void> {
  const { vault } = plugin.plugin.app;

  try {
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

    // Ensure the SS-Syncs folder exists
    let ssSyncsFolder = vault.getAbstractFileByPath(ssSyncsPath);
    if (!ssSyncsFolder) {
      ssSyncsFolder = await vault.createFolder(ssSyncsPath);
    }

    for (const template of templates) {
      const { content } = template;
      const fullPath = normalizePath(`${ssSyncsPath}/${template.path}`);

      const existingFile = vault.getAbstractFileByPath(fullPath);
      if (existingFile) {
        if (existingFile instanceof TFile) {
          await vault.modify(existingFile, content);
        }
      } else {
        await vault.create(fullPath, content);
      }
    }

    showCustomNotice(
      'SS-Sync Templates downloaded successfully! Thanks for your support on Patreon!'
    );
  } catch (error) {
    console.error('Error downloading templates:', error);
    showCustomNotice(
      "Failed to download templates. Please check your SystemSculpt Patreon's license key and try again."
    );
  }
}
