import { Setting } from 'obsidian';
import { TemplatesModule } from '../TemplatesModule';
import { downloadTemplatesFromServer } from '../functions/downloadTemplatesFromServer';
import { checkLicenseValidity } from '../functions/checkLicenseValidity'; // Make sure this import is correct
import { showCustomNotice } from '../../../modals'; // Ensure this import is correct based on your project structure

export function renderLicenseKeySetting(
  containerEl: HTMLElement,
  plugin: TemplatesModule
): void {
  let inputElement: HTMLInputElement; // Define a variable to hold the input element

  const licenseKeySetting = new Setting(containerEl)
    .setName('License key')
    .setDesc('Enter your license key to sync templates from the server')
    .addText(text => {
      text
        .setPlaceholder('Enter license key')
        .setValue(plugin.settings.licenseKey)
        .onChange(async value => {
          plugin.settings.licenseKey = value;
          await plugin.saveSettings(); // Save settings immediately on change
        });
      inputElement = text.inputEl; // Store the input element
    })
    .addButton(button => {
      button
        .setButtonText('Sync Templates')
        .setTooltip(
          'Sync templates from the server using the provided license key'
        )
        .onClick(async () => {
          button.setDisabled(false); // Disable the button
          setTimeout(() => button.setDisabled(false), 3000); // Re-enable after 3 seconds
          if (
            !plugin.settings.licenseKey ||
            plugin.settings.licenseKey.trim() === ''
          ) {
            showCustomNotice(
              'No valid license key found. Please enter your license key.',
              5000
            );
            return;
          }
          showCustomNotice('Checking your license key...');
          const isValid = await checkLicenseValidity(plugin, true);
          if (!isValid) {
            showCustomNotice(
              'Invalid license key. Please contact Mike on Patreon or Discord to obtain a valid license key.',
              5000
            );
            return;
          }
          downloadTemplatesFromServer(plugin);
        });
    });

  // Apply custom CSS class
  licenseKeySetting.settingEl.addClass('patreon-sub-setting');
}
