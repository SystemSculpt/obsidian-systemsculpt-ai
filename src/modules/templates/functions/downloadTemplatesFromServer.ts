import { TemplatesModule } from '../TemplatesModule';
import {
  Modal,
  App,
  normalizePath,
  requestUrl,
  TFile,
  TFolder,
} from 'obsidian';
import { showCustomNotice } from '../../../modals';
import { logger } from '../../../utils/logger';

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

async function isFolderEmpty(vault: any, folderPath: string): Promise<boolean> {
  const folder = vault.getAbstractFileByPath(folderPath);
  if (folder instanceof TFolder) {
    const children = folder.children;
    return children.length === 0;
  }
  return true;
}

export async function downloadTemplatesFromServer(
  plugin: TemplatesModule
): Promise<void> {
  try {
    const licenseKey = plugin.settings.licenseKey.trim();
    if (!licenseKey) {
      logger.log(
        'License key is empty. Skipping template version check and update.'
      );
      return;
    }

    const versionResponse = await requestUrl({
      url: 'https://license.systemsculpt.com/templates-version',
      method: 'GET',
    });

    const latestVersion = versionResponse.json.version;

    const userDefinedPath = plugin.settings.templatesPath;
    const ssSyncsPath = normalizePath(`${userDefinedPath}/SS-Syncs`);

    if (plugin.settings.templatesVersion !== latestVersion) {
      await performTemplateSync(plugin, latestVersion);
    } else {
      const userChoice = await new Promise<string>(resolve => {
        const modal = new ConfirmModal(
          plugin.plugin.app,
          resolve,
          'You already have the latest templates. Do you want to do a clean install of them?'
        );
        modal.open();
      });

      if (userChoice === 'overwrite') {
        await performTemplateSync(plugin, latestVersion);
      } else {
        showCustomNotice('Template sync cancelled.');
      }
    }
  } catch (error) {
    logger.error('Error downloading templates:', error);
    showCustomNotice(
      "Failed to download templates. Please check your SystemSculpt Patreon's license key and try again."
    );
  }
}

async function performTemplateSync(
  plugin: TemplatesModule,
  latestVersion: string
): Promise<void> {
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

  // Check if the SS-Syncs directory is empty
  const isEmpty = await isFolderEmpty(plugin.plugin.app.vault, ssSyncsPath);
  if (!isEmpty) {
    // Show a modal with Cancel/Overwrite options
    const userChoice = await new Promise<string>(resolve => {
      const modal = new ConfirmModal(
        plugin.plugin.app,
        resolve,
        'The SS-Syncs directory is not empty. Overwriting will replace all existing templates. If you have made any personal changes, please back them up and move them to a different directory.'
      );
      modal.open();
    });

    if (userChoice === 'cancel') {
      showCustomNotice('Template sync cancelled.');
      return;
    }
  }

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
}

class ConfirmModal extends Modal {
  private resolve: (value: string) => void;
  private message: string;

  constructor(app: App, resolve: (value: string) => void, message: string) {
    super(app);
    this.resolve = resolve;
    this.message = message;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Overwrite SS-Syncs Templates?' });
    contentEl.createEl('p', { text: this.message });

    const buttonContainer = contentEl.createDiv('modal-button-container');
    const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
    const overwriteButton = buttonContainer.createEl('button', {
      text: 'Overwrite',
    });

    cancelButton.addEventListener('click', () => {
      this.resolve('cancel');
      this.close();
    });

    overwriteButton.addEventListener('click', () => {
      this.resolve('overwrite');
      this.close();
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
