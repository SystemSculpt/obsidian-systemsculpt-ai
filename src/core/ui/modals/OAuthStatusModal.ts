import { App, Modal } from "obsidian";

/**
 * Modal that manages the full OAuth lifecycle:
 *   waiting -> paste-fallback (if needed) -> success
 *
 * Each state is rendered via a dedicated method that clears previous content
 * before drawing the new UI.
 */
export class OAuthStatusModal extends Modal {
  private readonly providerName: string;
  private pasteReject: ((reason: Error) => void) | null = null;
  private successResolve: (() => void) | null = null;
  private listeners: { element: EventTarget; type: string; handler: EventListener }[] = [];

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
    this.addListener(cancelBtn, "click", () => {
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
      this.addListener(submitBtn, "click", () => {
        const value = textarea.value.trim();
        if (!value) return; // ignore empty submissions
        this.pasteReject = null;
        resolve(value);
        this.close();
      });

      const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
      this.addListener(cancelBtn, "click", () => {
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

      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        this.successResolve = null;
        resolve();
        this.close();
      };

      this.addListener(okBtn, "click", finish);

      this.addListener(this.contentEl, "keydown", ((e: KeyboardEvent) => {
        if (e.key === "Enter") {
          finish();
        }
      }) as EventListener);
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  onClose(): void {
    this.removeAllListeners();
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

  private addListener(element: EventTarget, type: string, handler: EventListener): void {
    element.addEventListener(type, handler);
    this.listeners.push({ element, type, handler });
  }

  private removeAllListeners(): void {
    for (const { element, type, handler } of this.listeners) {
      element.removeEventListener(type, handler);
    }
    this.listeners = [];
  }

  private clearContent(): void {
    this.removeAllListeners();
    this.titleEl.textContent = "";
    this.contentEl.textContent = "";
  }
}
