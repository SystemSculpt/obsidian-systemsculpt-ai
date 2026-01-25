import { App, Modal, setIcon, Notice } from "obsidian";

export class MermaidPreviewModal extends Modal {
  private readonly code: string;

  constructor(app: App, code: string) {
    super(app);
    this.code = code;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("systemsculpt-mermaid-preview-modal");

    /* ------------------------- Header ------------------------- */
    const header = contentEl.createDiv({ cls: "ss-mermaid-preview-header" });
    header.createEl("h2", { text: "Mermaid Diagram" });

    const closeBtn = header.createDiv({ cls: "ss-mermaid-preview-close" });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.close());

    /* ------------------ Diagram container --------------------- */
    const diagramContainer = contentEl.createDiv({ cls: "ss-mermaid-preview-diagram mermaid" });
    diagramContainer.textContent = this.code;

    // Render via global Mermaid (core plugin)
    const m = (globalThis as any).mermaid;
    if (m && typeof m.init === "function") {
      try {
        // Ensure our diagram picks up theme overrides
        m.init(undefined, diagramContainer);
      } catch (err) {
      }
    }

    /* ------------------------- Footer ------------------------- */
    const footer = contentEl.createDiv({ cls: "ss-mermaid-preview-footer" });
    const copyBtn = footer.createEl("button", { cls: "ss-mermaid-copy-btn", text: "Copy Code" });

    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(this.code).then(() => {
        new Notice("Mermaid code copied to clipboard");
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
} 