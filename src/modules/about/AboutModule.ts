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

    // Documentation Section
    const docContainer = containerEl.createDiv('about-doc-container');
    docContainer.createEl('h3', {
      text: 'Documentation & Resources',
      cls: 'about-section-header',
    });

    const docButtons = [
      {
        name: 'Complete Documentation',
        url: 'https://www.systemsculpt.com/docs',
      },
      {
        name: 'Quick Start Guide',
        url: 'https://www.systemsculpt.com/docs/getting-started',
      },
      {
        name: 'Features Overview',
        url: 'https://www.systemsculpt.com/docs/features',
      },
      {
        name: 'Troubleshooting Guide',
        url: 'https://www.systemsculpt.com/docs/troubleshooting',
      },
      { name: 'FAQ', url: 'https://www.systemsculpt.com/docs/faq' },
      { name: 'Submit Issue', url: 'https://systemsculpt.com/submit-issue' },
    ];

    this.createButtonGroup(docContainer, docButtons, '');

    // Personal Links Section
    const personalContainer = containerEl.createDiv('about-personal-container');
    personalContainer.createEl('h3', {
      text: 'Connect & Support',
      cls: 'about-section-header',
    });

    const personalButtons = [
      { name: 'Patreon', url: 'https://www.patreon.com/SystemSculpt' },
      { name: 'YouTube', url: 'https://www.youtube.com/@systemsculpt' },
      { name: 'X (Twitter)', url: 'https://x.com/systemsculpt' },
      { name: 'GitHub', url: 'https://github.com/systemsculpt' },
      { name: 'Buy Coffee', url: 'https://www.buymeacoffee.com/SystemSculpt' },
      { name: 'Email', url: 'mailto:systemsculpt@gmail.com' },
    ];

    this.createButtonGroup(personalContainer, personalButtons, '');
  }

  private createButtonGroup(
    container: HTMLElement,
    buttons: { name: string; url: string }[],
    buttonClass: string
  ): void {
    const buttonContainer = container.createDiv('about-button-container');
    buttons.forEach(button => {
      const buttonEl = buttonContainer.createEl('button', {
        text: button.name,
        cls: buttonClass,
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

    const sponsorDescriptionEl = sectionEl.createEl('p', {
      text: 'By sponsoring or donating, you allow me to put more time into this and other Obsidian tools to benefit your productivity.',
      cls: 'about-description',
    });

    const listEl = sectionEl.createEl('div', { cls: 'supporter-list' });
    supporters.forEach(supporter => {
      const itemEl = listEl.createEl('span', { cls: 'supporter-item' });
      itemEl.setText(supporter.name);
    });
  }
}
