import { App, PluginSettingTab, Setting } from 'obsidian';
import { TemplatesModule } from '../TemplatesModule';
import { renderLicenseKeySetting } from './LicenseKeySetting';
import { renderTemplatesPathSetting } from './TemplatesPathSetting';
import { renderBlankTemplatePromptSetting } from './BlankTemplatePromptSetting';

export class TemplatesSettingTab extends PluginSettingTab {
  plugin: TemplatesModule;

  constructor(app: App, plugin: TemplatesModule, containerEl: HTMLElement) {
    super(app, plugin.plugin);
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();
    new Setting(containerEl).setName('Templates').setHeading();
    containerEl.createEl('p', {
      text: 'Change your default AI templates location, what your default blank prompt does in the background, and more.',
    });

    // Add Patreon member toggle with custom style
    const patreonSetting = new Setting(containerEl)
      .setName('Are you a Patreon member?')
      .setDesc('Toggle to show Patreon member options')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.isPatreonMember)
          .onChange(async (value: boolean) => {
            this.plugin.settings.isPatreonMember = value;
            await this.plugin.saveSettings();
            this.display(); // Refresh the settings view
          });
      });

    // Apply custom CSS class
    patreonSetting.settingEl.addClass('patreon-member-setting');

    if (this.plugin.settings.isPatreonMember) {
      const infoBoxEl = containerEl.createDiv('info-box');
      infoBoxEl.createEl('p', {
        text: "If you're a Patreon member, download the latest AI templates from SystemSculpt!",
      });

      // Apply custom CSS class to info box
      infoBoxEl.addClass('patreon-sub-setting');

      renderLicenseKeySetting(containerEl, this.plugin);

      const ssSyncSetting = new Setting(containerEl)
        .setName('Show SS-Sync templates in suggestions')
        .setDesc('Toggle the display of templates within the SS-Sync folder')
        .addToggle(toggle => {
          toggle
            .setValue(this.plugin.settings.showSSSyncTemplates)
            .onChange(async (value: boolean) => {
              this.plugin.settings.showSSSyncTemplates = value;
              await this.plugin.saveSettings();
            });

          const keepInMindBoxEl = containerEl.createDiv('info-box');
          keepInMindBoxEl.createEl('p', {
            text: "Whenever you sync to the latest templates, all templates found in the SS-Sync folder will be overwritten. This means that if you want to modify one to your own liking, make sure to place it in the Templates folder, outside of the SS-Sync directory - it will be safe there and won't be overwritten.",
          });

          // Apply custom CSS class to keepInMindBoxEl
          keepInMindBoxEl.addClass('patreon-sub-setting');
        });

      // Apply custom CSS class to ssSyncSetting
      ssSyncSetting.settingEl.addClass('patreon-sub-setting');
    } else {
      const becomePatreonEl = containerEl.createDiv('info-box');
      const becomePatreonButton = becomePatreonEl.createEl('button', {
        cls: 'patreon-sub-setting-button',
        text: 'Click here to become a Patreon member for only $10 bucks!',
      });
      becomePatreonButton.addEventListener('click', () => {
        window.open('https://patreon.com/systemsculpt', '_blank');
      });
    }

    new Setting(containerEl)
      .setName('Trigger key')
      .setDesc(
        'The key that triggers the template suggestion modal (single character only)'
      )
      .addText(text => {
        text
          .setPlaceholder('Enter trigger key')
          .setValue(this.plugin.settings.triggerKey);

        text.inputEl.addEventListener(
          'keydown',
          async (event: KeyboardEvent) => {
            event.preventDefault();
            const triggerKey = event.key.length === 1 ? event.key : '/';
            this.plugin.settings.triggerKey = triggerKey;
            await this.plugin.saveSettings();
            text.setValue(triggerKey);
          }
        );
      })
      .addExtraButton(button => {
        button
          .setIcon('reset')
          .setTooltip('Reset to default trigger key')
          .onClick(async () => {
            this.plugin.settings.triggerKey = '/';
            await this.plugin.saveSettings();
            this.display(); // Refresh the settings view
          });
      });

    renderTemplatesPathSetting(containerEl, this.plugin);
    renderBlankTemplatePromptSetting(containerEl, this.plugin);
  }
}
