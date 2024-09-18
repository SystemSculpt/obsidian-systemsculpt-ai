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

let activeNotice: Notice | null = null;

export function showCustomNotice(
  message: string,
  duration: number = 5000,
  until_hidden: boolean = false
): Notice {
  if (activeNotice) {
    // Update existing notice
    const noticeEl = activeNotice.noticeEl.querySelector('.custom-notice-message');
    if (noticeEl) {
      noticeEl.innerHTML = ''; // Clear existing content
      if (message.includes('...')) {
        const parts = message.split('...');
        const textPart = document.createElement('span');
        textPart.textContent = parts[0];
        noticeEl.appendChild(textPart);

        const dotsSpan = document.createElement('span');
        dotsSpan.classList.add('revolving-dots');
        dotsSpan.textContent = '...';
        noticeEl.appendChild(dotsSpan);

        if (parts.length > 1 && parts[1].trim() !== '') {
          const extraSpan = document.createElement('span');
          extraSpan.textContent = parts[1];
          noticeEl.appendChild(extraSpan);
        }
      } else {
        noticeEl.textContent = message;
      }
    }
    return activeNotice;
  }

  // Create a new notice if none is active
  activeNotice = new Notice('', until_hidden ? 0 : duration);
  const noticeContentEl = activeNotice.noticeEl.createDiv('custom-notice-content');
  const messageDiv = noticeContentEl.createDiv('custom-notice-message');

  if (message.includes('...')) {
    const parts = message.split('...');
    messageDiv.textContent = parts[0];
    const revolvingSpan = noticeContentEl.createSpan();
    revolvingSpan.classList.add('revolving-dots');
    revolvingSpan.textContent = '...';
    if (parts[1]) {
      const extraSpan = document.createElement('span');
      extraSpan.textContent = parts[1];
      noticeContentEl.appendChild(extraSpan);
    }
  } else {
    messageDiv.textContent = message;
  }

  activeNotice.noticeEl.classList.add('custom-notice');
  activeNotice.noticeEl.addEventListener('click', () => {
    activeNotice?.hide();
    activeNotice = null;
  });

  let noticeContainer = document.body.querySelector('.notice-container');
  if (!noticeContainer) {
    noticeContainer = document.createElement('div');
    noticeContainer.className = 'notice-container';
    document.body.appendChild(noticeContainer);
  }

  noticeContainer.appendChild(activeNotice.noticeEl);
  activeNotice.noticeEl.classList.add('custom-notice-position');

  if (message.startsWith('Generating')) {
    activeNotice.noticeEl.classList.add('generating-notice');
  }

  // When the notice hides, reset the activeNotice reference
  activeNotice.hide = () => {
    activeNotice = null;
  };

  return activeNotice;
}

export function hideCustomNotice(): void {
  if (activeNotice) {
    activeNotice.hide();
    activeNotice = null;
  }
}
