import { Setting } from 'obsidian';
import { TemplatesModule } from '../TemplatesModule';
import { downloadTemplatesFromServer } from '../functions/downloadTemplatesFromServer';
import { debounce } from 'lodash';
import { showCustomNotice } from '../../../modals'; // Ensure this import is correct based on your project structure

export function renderLicenseKeySetting(
  containerEl: HTMLElement,
  plugin: TemplatesModule
): void {
  let inputElement: HTMLInputElement; // Define a variable to hold the input element

  const debouncedSync = debounce(async () => {
    await downloadTemplatesFromServer(plugin);
  }, 3000);

  new Setting(containerEl)
    .setName('License Key')
    .setDesc('Enter your license key to sync templates from the server')
    .addText(text => {
      text
        .setPlaceholder('Enter license key')
        .setValue(plugin.settings.licenseKey)
        .onChange(
          debounce(async value => {
            plugin.settings.licenseKey = value;
            await plugin.saveSettings();
          }, 3000)
        ); // Debounce for 3 seconds
      inputElement = text.inputEl; // Store the input element
    })
    .addButton(button => {
      button
        .setButtonText('Sync Templates')
        .setTooltip(
          'Sync templates from the server using the provided license key'
        )
        .onClick(() => {
          showCustomNotice('Checking your Patreon license key...');
          debouncedSync();
        });
    });
}
