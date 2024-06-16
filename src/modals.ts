import { App, Modal, Notice } from 'obsidian';

export class GeneratingTitleModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    let { contentEl } = this;

    contentEl.addClass('modal-content-centered');

    const header = contentEl.createEl('h2', { text: 'Generating Title...' });
    header.addClass('modal-header');

    const spinner = this.contentEl.createDiv('spinner');
    spinner.createDiv('double-bounce1');
    spinner.createDiv('double-bounce2');
  }

  onClose(): void {
    let { contentEl } = this;
    contentEl.empty();
  }
}

export class LoadingModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    let { contentEl } = this;

    contentEl.addClass('modal-content-centered');

    const header = contentEl.createEl('h2', { text: 'Generating Task...' });
    header.addClass('modal-header');

    const spinner = this.contentEl.createDiv('spinner');
    spinner.createDiv('double-bounce1');
    spinner.createDiv('double-bounce2');
  }

  onClose(): void {
    let { contentEl } = this;
    contentEl.empty();
  }
}

export function showCustomNotice(
  message: string,
  duration: number = 5000,
  until_hidden: boolean = false
): Notice {
  const notice = new Notice('', until_hidden ? 0 : duration);
  const noticeContentEl = notice.noticeEl.createDiv('custom-notice-content');
  const messageDiv = noticeContentEl.createDiv('custom-notice-message');

  if (message.includes('...')) {
    const parts = message.split('...');
    messageDiv.textContent = parts[0];
    const revolvingSpan = messageDiv.createSpan();
    revolvingSpan.addClass('revolving-dots');
    if (parts[1]) {
      messageDiv.createSpan().textContent = parts[1];
    }
  } else {
    messageDiv.textContent = message;
  }

  notice.noticeEl.addClass('custom-notice');
  notice.noticeEl.addEventListener('click', () => notice.hide());

  const noticeContainer = document.body.querySelector('.notice-container');
  if (!noticeContainer) {
    const createdContainer = document.createElement('div');
    createdContainer.className = 'notice-container';
    document.body.appendChild(createdContainer);
    createdContainer.appendChild(notice.noticeEl);
  } else {
    noticeContainer.appendChild(notice.noticeEl);
  }

  notice.noticeEl.addClass('custom-notice-position');

  if (message.startsWith('Generating')) {
    notice.noticeEl.addClass('generating-notice');
  }

  return notice;
}

export function hideCustomNotice(): void {
  const notice = document.querySelector('.custom-notice');
  if (notice) {
    notice.remove();
  }
}
