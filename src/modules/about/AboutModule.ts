import { App, PluginSettingTab, Setting } from 'obsidian';
import SystemSculptPlugin from '../../main';
import { members } from './AboutData';

export class AboutModule {
  plugin: SystemSculptPlugin;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
  }

  async load() {}

  settingsDisplay(containerEl: HTMLElement): void {
    new AboutSettingTab(this.plugin.app, this, containerEl).display();
  }
}

class AboutSettingTab extends PluginSettingTab {
  plugin: AboutModule;

  constructor(app: App, plugin: AboutModule, containerEl: HTMLElement) {
    super(app, plugin.plugin);
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();

    this.renderGeneral(containerEl);
    this.renderHallOfFame(containerEl);
  }

  private renderGeneral(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('About SystemSculpt').setHeading();

    containerEl.createEl('p', {
      text: 'By sponsoring or donating, you allow me to put more time into this and other Obsidian tools to benefit your productivity.',
      cls: 'about-description',
    });

    const buttonContainer = containerEl.createDiv('about-button-container');

    const buttons = [
      { name: 'Patreon', url: 'https://www.patreon.com/SystemSculpt' },
      { name: 'YouTube', url: 'https://www.youtube.com/@systemsculpt' },
      { name: 'X (Twitter)', url: 'https://x.com/systemsculpt' },
      { name: 'GitHub', url: 'https://github.com/systemsculpt' },
      { name: 'Buy Coffee', url: 'https://www.buymeacoffee.com/SystemSculpt' },
      { name: 'Email', url: 'mailto:systemsculpt@gmail.com' },
    ];

    buttons.forEach(button => {
      const buttonEl = buttonContainer.createEl('button', {
        text: button.name,
        cls: 'about-button',
      });
      buttonEl.addEventListener('click', () => {
        window.open(button.url, '_blank');
      });
    });
  }

  private async renderHallOfFame(containerEl: HTMLElement): Promise<void> {
    const hallOfFameEl = containerEl.createDiv('about-hall-of-fame');

    const uniqueSupporters = members.reduce<{ name: string }[]>(
      (acc, current) => {
        if (!acc.some(item => item.name === current.name)) {
          acc.push(current);
        }
        return acc;
      },
      []
    );

    this.renderSupportersSection(
      hallOfFameEl,
      'SystemSculpt Supporters',
      uniqueSupporters
    );
  }

  private renderSupportersSection(
    containerEl: HTMLElement,
    title: string,
    supporters: { name: string }[]
  ): void {
    const sectionEl = containerEl.createDiv('supporters-section');
    const titleEl = sectionEl.createEl('h3', { text: title });
    titleEl.addClass('ss-h3');

    const descriptionEl = sectionEl.createEl('p', {
      text: 'This section is dedicated to all Patreon members! Your support as a Patreon member allows me to dedicate more time to developing SystemSculpt productivity tools. Thank you!',
    });
    descriptionEl.addClass('supporters-description');

    const listEl = sectionEl.createEl('div', { cls: 'supporter-list' });
    supporters.forEach(supporter => {
      const itemEl = listEl.createEl('span', { cls: 'supporter-item' });
      itemEl.setText(supporter.name);
    });
  }
}
