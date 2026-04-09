import { App, Modal } from "obsidian";

/**
 * Modal that manages the full OAuth lifecycle:
 *   waiting -> paste-fallback (if needed) -> success
 *
 * Each state is rendered via a dedicated method that clears previous content
 * before drawing the new UI.
 */
export class OAuthStatusModal extends Modal {
  private providerName: string;
  private pasteReject: ((reason: Error) => void) | null = null;
  private successResolve: (() => void) | null = null;

  constructor(app: App, providerName: string) {
    super(app);
    this.providerName = providerName;
  }

  // ── State: Waiting ─────────────────────────────────────────────────

  showWaiting(onCancel: () => void): void {
    this.clearContent();

    this.titleEl.textContent = `Connecting to ${this.providerName}...`;

    this.contentEl.createDiv({
      text: "Complete authentication in your browser. This window will update automatically.",
    });

    const btnContainer = this.contentEl.createDiv({
      cls: "modal-button-container",
    });
    const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      onCancel();
    });
  }

  // ── State: Paste Fallback ──────────────────────────────────────────

  showPasteFallback(): Promise<string> {
    this.clearContent();

    this.titleEl.textContent = `Manual authentication for ${this.providerName}`;

    this.contentEl.createDiv({
      text: "Automatic callback couldn't connect. Paste the redirect URL or authorization code from your browser below.",
    });

    const textarea = this.contentEl.createEl("textarea");
    textarea.focus();

    const btnContainer = this.contentEl.createDiv({
      cls: "modal-button-container",
    });

    return new Promise<string>((resolve, reject) => {
      this.pasteReject = reject;

      const submitBtn = btnContainer.createEl("button", { text: "Submit", cls: "mod-cta" });
      submitBtn.addEventListener("click", () => {
        const value = textarea.value.trim();
        if (!value) return; // ignore empty submissions
        this.pasteReject = null;
        resolve(value);
        this.close();
      });

      const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
      cancelBtn.addEventListener("click", () => {
        this.pasteReject = null;
        reject(new Error("Login cancelled."));
        this.close();
      });
    });
  }

  // ── State: Success ─────────────────────────────────────────────────

  showSuccess(): Promise<void> {
    this.clearContent();

    this.titleEl.textContent = `Connected to ${this.providerName}`;

    this.contentEl.createDiv({
      text: `Authentication successful. You're ready to use ${this.providerName}.`,
    });

    const btnContainer = this.contentEl.createDiv({
      cls: "modal-button-container",
    });

    return new Promise<void>((resolve) => {
      this.successResolve = resolve;

      const okBtn = btnContainer.createEl("button", { text: "OK", cls: "mod-cta" });
      okBtn.focus();

      const finish = () => {
        this.successResolve = null;
        resolve();
        this.close();
      };

      okBtn.addEventListener("click", finish);

      this.contentEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          finish();
        }
      });
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  onClose(): void {
    // Handle Escape key or external close while in paste-fallback
    if (this.pasteReject) {
      const reject = this.pasteReject;
      this.pasteReject = null;
      reject(new Error("Login cancelled."));
    }
    // Handle Escape key or external close while in success state
    if (this.successResolve) {
      const resolve = this.successResolve;
      this.successResolve = null;
      resolve();
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private clearContent(): void {
    this.titleEl.textContent = "";
    this.contentEl.textContent = "";
  }
}
