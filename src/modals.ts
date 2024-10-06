import { App, Modal, Notice } from "obsidian";

export class GeneratingTitleModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    let { contentEl } = this;

    contentEl.addClass("modal-content-centered");

    const header = contentEl.createEl("h2", { text: "Generating Title..." });
    header.addClass("modal-header");

    const spinner = this.contentEl.createDiv("spinner");
    spinner.createDiv("double-bounce1");
    spinner.createDiv("double-bounce2");
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

    contentEl.addClass("modal-content-centered");

    const header = contentEl.createEl("h2", { text: "Generating Task..." });
    header.addClass("modal-header");

    const spinner = this.contentEl.createDiv("spinner");
    spinner.createDiv("double-bounce1");
    spinner.createDiv("double-bounce2");
  }

  onClose(): void {
    let { contentEl } = this;
    contentEl.empty();
  }
}

export function showCustomNotice(
  message: string,
  duration: number = 5000,
): Notice {
  return new Notice(message, duration);
}
