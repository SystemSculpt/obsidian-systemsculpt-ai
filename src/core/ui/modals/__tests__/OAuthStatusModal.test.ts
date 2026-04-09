/** @jest-environment jsdom */

import { App } from "obsidian";
import { OAuthStatusModal } from "../OAuthStatusModal";

describe("OAuthStatusModal", () => {
  beforeEach(() => {
    document.body.textContent = "";
  });

  it("opens in waiting state with provider name and cancel button", () => {
    const modal = new OAuthStatusModal(new App(), "Google");
    modal.open();
    modal.showWaiting(() => {});

    expect(modal.titleEl.textContent).toBe("Connecting to Google...");
    expect(modal.contentEl.textContent).toContain(
      "Complete authentication in your browser."
    );

    const cancelBtn = modal.contentEl.querySelector("button");
    expect(cancelBtn).toBeTruthy();
    expect(cancelBtn?.textContent).toBe("Cancel");
  });

  it("calls onCancel when cancel button clicked in waiting state", () => {
    const onCancel = jest.fn();
    const modal = new OAuthStatusModal(new App(), "Google");
    modal.open();
    modal.showWaiting(onCancel);

    const cancelBtn = modal.contentEl.querySelector("button");
    cancelBtn?.click();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("transitions to paste-fallback with textarea; returns user input on submit", async () => {
    const modal = new OAuthStatusModal(new App(), "OpenAI");
    modal.open();

    const resultPromise = modal.showPasteFallback();

    expect(modal.titleEl.textContent).toBe("Manual authentication for OpenAI");
    expect(modal.contentEl.textContent).toContain(
      "Paste the redirect URL or authorization code"
    );

    const textarea = modal.contentEl.querySelector("textarea");
    expect(textarea).toBeTruthy();

    textarea!.value = "https://localhost/callback?code=abc123";

    const submitBtn = Array.from(
      modal.contentEl.querySelectorAll<HTMLButtonElement>("button")
    ).find((b) => b.textContent === "Submit");
    submitBtn?.click();

    const result = await resultPromise;
    expect(result).toBe("https://localhost/callback?code=abc123");
  });

  it("rejects paste-fallback promise when user cancels", async () => {
    const modal = new OAuthStatusModal(new App(), "OpenAI");
    modal.open();

    const resultPromise = modal.showPasteFallback();

    const cancelBtn = Array.from(
      modal.contentEl.querySelectorAll<HTMLButtonElement>("button")
    ).find((b) => b.textContent === "Cancel");
    cancelBtn?.click();

    await expect(resultPromise).rejects.toThrow("Login cancelled.");
  });

  it("transitions to success state; OK button dismisses", async () => {
    const modal = new OAuthStatusModal(new App(), "Anthropic");
    modal.open();

    const resultPromise = modal.showSuccess();

    expect(modal.titleEl.textContent).toBe("Connected to Anthropic");
    expect(modal.contentEl.textContent).toContain("Authentication successful.");

    const okBtn = Array.from(
      modal.contentEl.querySelectorAll<HTMLButtonElement>("button")
    ).find((b) => b.textContent === "OK");
    expect(okBtn).toBeTruthy();

    okBtn?.click();

    await resultPromise;
    // If we get here without hanging, the promise resolved
  });

  it("resolves success state on Enter key", async () => {
    const modal = new OAuthStatusModal(new App(), "Anthropic");
    modal.open();

    const resultPromise = modal.showSuccess();

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    });
    modal.contentEl.dispatchEvent(event);

    await resultPromise;
    // If we get here without hanging, the promise resolved on Enter
  });

  it("does not submit paste-fallback with empty textarea", async () => {
    const modal = new OAuthStatusModal(new App(), "OpenAI");
    modal.open();

    const resultPromise = modal.showPasteFallback();

    const textarea = modal.contentEl.querySelector("textarea");
    expect(textarea).toBeTruthy();
    // textarea value is empty by default

    const submitBtn = Array.from(
      modal.contentEl.querySelectorAll<HTMLButtonElement>("button")
    ).find((b) => b.textContent === "Submit");
    submitBtn?.click();

    // Submit should have been ignored; now cancel to end the test cleanly
    const cancelBtn = Array.from(
      modal.contentEl.querySelectorAll<HTMLButtonElement>("button")
    ).find((b) => b.textContent === "Cancel");
    cancelBtn?.click();

    await expect(resultPromise).rejects.toThrow("Login cancelled.");
  });
});
