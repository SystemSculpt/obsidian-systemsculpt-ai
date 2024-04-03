import { App, PluginSettingTab, Setting } from 'obsidian';
import SystemSculptPlugin from '../../main';
import { AboutData } from './AboutData';

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

    const contentContainer = containerEl.createDiv('about-content-container');

    this.renderGeneral(contentContainer);
    this.renderHallOfFame(contentContainer);
  }

  private renderGeneral(containerEl: HTMLElement): void {
    const contentEl = containerEl.createDiv('about-content');

    const descEl = contentEl.createDiv('about-description');

    const justMeh3 = descEl.createEl('h3', { text: "It's just me :D" });
    justMeh3.addClass('ss-h3');

    descEl.createEl('p', {
      text: 'By sponsoring or donating, you allow me to put more time into this and other Obsidian tools to benefit your productivity.',
    });

    const supportEl = contentEl.createDiv('about-support');
    const patreonLink = supportEl.createEl('a', {
      href: 'https://www.patreon.com/SystemSculpt',
      cls: 'support-link',
    });
    patreonLink.createSpan({ cls: 'icon', text: 'P' });
    patreonLink.createSpan({ text: 'Become a Patron' });

    const coffeeLink = supportEl.createEl('a', {
      href: 'https://www.buymeacoffee.com/SystemSculpt',
      cls: 'support-link',
    });
    coffeeLink.createSpan({ cls: 'icon', text: 'C' });
    coffeeLink.createSpan({ text: 'Buy Me a Coffee' });

    const socialEl = contentEl.createDiv('about-social');
    const socialLinks = [
      {
        name: 'YouTube',
        url: 'https://www.youtube.com/systemsculpt',
        icon: 'Y',
      },
      {
        name: 'X (Twitter)',
        url: 'https://x.com/systemsculpt',
        icon: 'X',
      },
      {
        name: 'GitHub',
        url: 'https://github.com/systemsculpt',
        icon: 'G',
      },
    ];

    const socialList = socialEl.createEl('ul', { cls: 'social-list' });
    socialLinks.forEach(link => {
      const listItem = socialList.createEl('li');
      const linkEl = listItem.createEl('a', {
        href: link.url,
        cls: 'social-link',
      });
      linkEl.createSpan({ cls: 'icon', text: link.icon });
      linkEl.createSpan({ text: link.name });
    });

    // Contact
    const contactEl = containerEl.createDiv('about-contact');
    contactEl.createEl('p', {
      text: 'For any inquiries, suggestions, or feedback, please reach out via email:',
    });
    contactEl.createEl('a', {
      href: 'mailto:systemsculpt@gmail.com',
      cls: 'contact-link',
      text: 'systemsculpt@gmail.com',
    });
  }

  private async renderHallOfFame(containerEl: HTMLElement): Promise<void> {
    const hallOfFameEl = containerEl.createDiv('about-hall-of-fame');

    // Render "Bought Me a Coffee" section
    this.renderMembershipSection(
      hallOfFameEl,
      'Bought Me a Coffee',
      AboutData.buyMeACoffee,
      'bmac-section',
      'bmac-yellow',
      'Buy Me Some Coffee!',
      'https://www.buymeacoffee.com/SystemSculpt'
    );

    // Render "Patreon" section
    this.renderMembershipSection(
      hallOfFameEl,
      'Patreon Supporters',
      AboutData.patreonMembers,
      'patreon-section',
      'patreon-blue',
      'Become a Patron',
      'https://www.patreon.com/SystemSculpt'
    );

    // Render "YouTube" section
    this.renderMembershipSection(
      hallOfFameEl,
      'YouTube Members',
      AboutData.youtubeMembers,
      'youtube-section',
      'youtube-red',
      'Become a YouTube Member',
      'https://www.youtube.com/channel/your-channel-id/join'
    );
  }

  private renderMembershipSection(
    containerEl: HTMLElement,
    title: string,
    members: any[],
    sectionClass: string,
    colorClass: string,
    linkText: string,
    linkUrl: string
  ): void {
    const sectionEl = containerEl.createDiv(sectionClass);
    const titleEl = sectionEl.createEl('h3', { text: title });
    titleEl.addClass(colorClass);
    titleEl.addClass('ss-h3');

    const linkEl = sectionEl.createEl('a', {
      text: linkText,
      href: linkUrl,
      cls: 'section-link',
    });
    linkEl.addClass(colorClass);

    const listEl = sectionEl.createEl('ul', { cls: 'supporter-list' });
    const chunkSize = 3;
    for (let i = 0; i < members.length; i += chunkSize) {
      const chunk = members.slice(i, i + chunkSize);
      const rowEl = listEl.createEl('li', { cls: 'supporter-row' });
      chunk.forEach(member => {
        const itemEl = rowEl.createEl('div', { cls: 'supporter-item' });
        itemEl.createSpan({ text: member.name });

        if (member.coffees) {
          itemEl.createSpan({
            cls: 'supporter-contribution',
            text: `${member.coffees} coffee${member.coffees > 1 ? 's' : ''}`,
          });
        }
      });
    }
  }
}
