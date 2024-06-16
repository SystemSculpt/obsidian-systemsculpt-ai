import { Modal, App } from 'obsidian';
import { showCustomNotice } from '../../../modals';

export class TitleEditModal extends Modal {
  currentTitle: string;
  onSave: (newTitle: string) => void;

  constructor(
    app: App,
    currentTitle: string,
    onSave: (newTitle: string) => void
  ) {
    super(app);
    this.currentTitle = currentTitle;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('title-edit-modal'); // Add this line to apply the modal styles

    contentEl.createEl('h2', { text: 'Edit Title' });

    const inputEl = contentEl.createEl('textarea', {
      text: this.currentTitle,
      cls: 'title-edit-input',
    });

    // Select the entire text in the textarea
    inputEl.setSelectionRange(0, this.currentTitle.length);

    // Add keydown event listener to handle Enter key press
    inputEl.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault(); // Prevent default behavior of Enter key
        this.onSave(inputEl.value);
        this.close();
      }
    });

    inputEl.addEventListener('input', () => {
      const invalidChars = /[<>:"/\\|?*\x00-\x1F]/g;
      if (invalidChars.test(inputEl.value)) {
        const invalidCharacter = inputEl.value.match(invalidChars)?.[0];
        showCustomNotice(
          'You cannot use the ' +
            invalidCharacter +
            ' character within a title.'
        );
        inputEl.value = inputEl.value.replace(invalidChars, '');
      }
    });

    const saveButton = contentEl.createEl('button', {
      text: 'Save',
      cls: 'save-button',
    });

    saveButton.addEventListener('click', () => {
      this.onSave(inputEl.value);
      this.close();
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
