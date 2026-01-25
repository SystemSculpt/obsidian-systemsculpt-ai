import { App, Modal, Setting } from "obsidian";

export class ImproveResponseModal extends Modal {
  private _globalKeyHandler: (e: KeyboardEvent) => void;
  private promptText: string;
  private defaultValue: string;
  private onSubmit: (input: string) => void;
  private inputEl: HTMLInputElement;

  constructor(app: App, promptText: string, defaultValue: string, onSubmit: (input: string) => void) {
    super(app);
    this.promptText = promptText;
    this.defaultValue = defaultValue;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.empty();

    contentEl.createEl("h2", { text: "Improve Response" });

    contentEl.createEl("p", { text: this.promptText });

    // Preset buttons container
    const presetContainer = contentEl.createDiv();
    presetContainer.style.display = "flex";
    presetContainer.style.flexWrap = "wrap";
    presetContainer.style.gap = "8px";
    presetContainer.style.marginTop = "8px";

    const presets = ["Shorter", "Longer", "Simpler", "More professional", "More creative"];
    presets.forEach((preset) => {
      const btn = presetContainer.createEl("button", { text: preset });
      btn.onclick = () => {
        this.inputEl.value = preset;
        this.inputEl.focus();
      };
    });

    this.inputEl = contentEl.createEl("input", {
      type: "text",
      placeholder: "E.g., shorter, longer, simpler, professional, creative, or custom instruction",
      value: this.defaultValue,
    });

    this.inputEl.style.width = "100%";
    this.inputEl.style.marginTop = "10px";
    this.inputEl.style.marginBottom = "20px";

    const buttonContainer = contentEl.createDiv();
    buttonContainer.style.display = "flex";
    buttonContainer.style.justifyContent = "flex-end";
    buttonContainer.style.gap = "10px";

    const cancelButton = buttonContainer.createEl("button", { text: "Cancel" });
    cancelButton.addClass("mod-muted");
    cancelButton.style.flex = "0 0 auto";
    cancelButton.onclick = () => {
      this.close();
    };

    const confirmButton = buttonContainer.createEl("button", { text: "Improve" });
    confirmButton.addClass("mod-cta");
    confirmButton.style.flex = "0 0 auto";
    confirmButton.onclick = () => {
      const value = this.inputEl.value.trim();
      if (!value) {
        this.inputEl.focus();
        return;
      }
      this.onSubmit(value);
      this.close();
    };

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        confirmButton.click();
      }
    });

    // Add global keydown listener for Cmd+Enter
    this._globalKeyHandler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "Enter") {
        e.preventDefault();
        confirmButton.click();
      }
    };
    document.addEventListener("keydown", this._globalKeyHandler);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();

    if (this._globalKeyHandler) {
      document.removeEventListener("keydown", this._globalKeyHandler);
    }
  }
}