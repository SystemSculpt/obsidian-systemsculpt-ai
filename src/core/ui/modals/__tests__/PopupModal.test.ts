/** @jest-environment jsdom */

import { App } from "obsidian";
import { PopupComponent, showPopup } from "../PopupModal";

describe("PopupModal", () => {
  afterEach(() => document.body.empty());

  it("uses the shared modal shell and focuses the first field", () => {
    const popup = new PopupComponent(new App(), "Paste the redirect URL.", {
      title: "Connect account",
      description: "Use Cmd/Ctrl+Enter to submit a textarea.",
      icon: "link",
      primaryButton: "Submit",
      inputs: [{ type: "textarea", placeholder: "https://...", required: true }],
    });

    void popup.open();

    const textarea = popup.modalEl.querySelector<HTMLTextAreaElement>("textarea");
    expect(popup.modalEl.classList.contains("ss-modal")).toBe(true);
    expect(popup.modalEl.classList.contains("ss-popup-modal")).toBe(true);
    expect(popup.modalEl.getAttribute("role")).toBe("dialog");
    expect(popup.modalEl.textContent).toContain("Connect account");
    expect(popup.modalEl.textContent).toContain("Paste the redirect URL.");
    expect(popup.modalEl.textContent).toContain("Use Cmd/Ctrl+Enter");
    expect(popup.modalEl.querySelector(".systemsculpt-popup-container")).toBeNull();
    expect(textarea).not.toBeNull();
    expect(document.activeElement).toBe(textarea);

    const submit = Array.from(popup.modalEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Submit");
    expect(submit?.disabled).toBe(true);
  });

  it("submits values without leaking the checkbox into the inputs array", async () => {
    const resultPromise = showPopup(new App(), "Paste the authorization code.", {
      title: "Manual sign in",
      primaryButton: "Submit",
      checkboxLabel: "Remember this choice",
      inputs: [{ type: "text", placeholder: "Code", required: true }],
    });

    const modalEl = document.body.querySelector<HTMLElement>(".ss-popup-modal")!;
    const input = modalEl.querySelector<HTMLInputElement>('input[type="text"]')!;
    const checkbox = modalEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const submit = Array.from(modalEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Submit")!;

    input.value = "oauth-code";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    checkbox.checked = true;
    submit.click();

    await expect(resultPromise).resolves.toEqual({
      confirmed: true,
      action: "primary",
      inputs: ["oauth-code"],
      checkboxChecked: true,
    });
  });

  it("resolves the secondary action separately from cancellation", async () => {
    const popup = new PopupComponent(new App(), "Discard the current draft?", {
      title: "Discard draft",
      primaryButton: "Discard",
      secondaryButton: "Keep editing",
    });

    const result = popup.open();
    Array.from(popup.modalEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Keep editing")
      ?.click();

    await expect(result).resolves.toEqual({
      confirmed: false,
      action: "secondary",
    });
  });

  it("cancels from Escape and the close button", async () => {
    const first = new PopupComponent(new App(), "Test message");
    const firstResult = first.open();
    first.modalEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(firstResult).resolves.toEqual({
      confirmed: false,
      action: "cancel",
    });

    const second = new PopupComponent(new App(), "Another message", { title: "Heads up" });
    const secondResult = second.open();
    second.modalEl.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click();
    await expect(secondResult).resolves.toEqual({
      confirmed: false,
      action: "cancel",
    });
  });

  it("submits from Enter on single-line fields and keeps textarea Enter free", async () => {
    const singleLine = showPopup(new App(), "Enter should submit here.", {
      primaryButton: "Submit",
      inputs: [{ type: "text", placeholder: "Code", required: true }],
    });

    const singleLineModal = document.body.querySelectorAll<HTMLElement>(".ss-popup-modal")[0]!;
    const singleLineInput = singleLineModal.querySelector<HTMLInputElement>('input[type="text"]')!;
    singleLineInput.value = "pasted-code";
    singleLineInput.dispatchEvent(new Event("input", { bubbles: true }));
    singleLineInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await expect(singleLine).resolves.toEqual({
      confirmed: true,
      action: "primary",
      inputs: ["pasted-code"],
      checkboxChecked: false,
    });

    const textareaPopup = new PopupComponent(new App(), "Textarea should not submit on plain Enter.", {
      primaryButton: "Submit",
      inputs: [{ type: "textarea", placeholder: "Notes", required: true, value: "draft" }],
    });
    const textareaResult = textareaPopup.open();
    const textarea = textareaPopup.modalEl.querySelector<HTMLTextAreaElement>("textarea")!;

    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(document.body.contains(textareaPopup.modalEl)).toBe(true);

    textarea.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      metaKey: true,
      bubbles: true,
    }));

    await expect(textareaResult).resolves.toEqual({
      confirmed: true,
      action: "primary",
      inputs: ["draft"],
      checkboxChecked: false,
    });
  });
});
