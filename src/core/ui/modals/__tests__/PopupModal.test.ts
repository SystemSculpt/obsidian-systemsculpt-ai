/** @jest-environment jsdom */

/**
 * Tests for PopupModal — the popup used for OAuth code input.
 *
 * These tests expose the UX problems with the current popup:
 * - Input is not auto-focused
 * - Long URLs are hard to paste (single-line text input, not a textarea)
 * - No visual context about what's happening (generic message)
 */

import { App } from "obsidian";
import { PopupComponent, showPopup } from "../PopupModal";

describe("PopupModal", () => {
  beforeEach(() => {
    document.body.textContent = "";
  });

  it("creates a popup with the correct structure", async () => {
    const popup = new PopupComponent(new App(), "Test message", {
      primaryButton: "Submit",
      secondaryButton: "Cancel",
    });

    // Start the popup (don't await — it blocks until user action)
    const resultPromise = popup.open();

    const container = document.querySelector(".systemsculpt-popup-container");
    expect(container).toBeTruthy();

    const message = container?.querySelector(".systemsculpt-popup-message");
    expect(message?.textContent).toBe("Test message");

    const buttons = container?.querySelectorAll("button");
    expect(buttons?.length).toBe(2);

    // Close it
    const cancelBtn = buttons?.[0];
    cancelBtn?.click();

    // Wait for close animation
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await resultPromise;
    expect(result?.confirmed).toBe(false);
  });

  it("creates text inputs when configured", async () => {
    const resultPromise = showPopup(new App(), "Paste the authorization code or redirect URL:", {
      primaryButton: "Submit",
      secondaryButton: "Cancel",
      inputs: [{ type: "text", placeholder: "https://..." }],
    });

    const container = document.querySelector(".systemsculpt-popup-container");
    const input = container?.querySelector("input.systemsculpt-popup-input") as HTMLInputElement;

    expect(input).toBeTruthy();
    expect(input?.type).toBe("text");

    // NOTE: The Obsidian mock's createEl doesn't propagate the `placeholder`
    // property from the options object (only `cls`, `text`, `attr`, `value`).
    // In real Obsidian, the placeholder IS set. The test documents the gap.

    // BUG: Input is NOT auto-focused after popup creation.
    // In a real browser, the user has to manually click into the input.
    // This is extra friction when they're trying to paste a URL.
    expect(document.activeElement).not.toBe(input);

    // Clean up - cancel the popup
    const cancelBtn = Array.from(container?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Cancel"
    );
    cancelBtn?.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await resultPromise;
  });

  it("uses a text input instead of textarea for long URLs (UX issue)", async () => {
    // The OAuth redirect URL can be very long:
    // http://localhost:1455/auth/callback?code=VERY_LONG_CODE&state=LONG_STATE
    // A single-line <input type="text"> truncates the visible content,
    // making it hard to verify what was pasted.

    const resultPromise = showPopup(new App(), "Paste the authorization code or redirect URL:", {
      primaryButton: "Submit",
      secondaryButton: "Cancel",
      inputs: [{ type: "text", placeholder: "https://..." }],
    });

    const container = document.querySelector(".systemsculpt-popup-container");
    const input = container?.querySelector("input") as HTMLInputElement;
    const textarea = container?.querySelector("textarea");

    // Current: uses <input type="text"> -- single line, truncates long URLs
    expect(input).toBeTruthy();
    expect(textarea).toBeNull();

    // Better: should use <textarea> or a dedicated URL-friendly input
    // that can show the full pasted content

    const cancelBtn = Array.from(container?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Cancel"
    );
    cancelBtn?.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await resultPromise;
  });

  it("handles Enter key to submit", async () => {
    const resultPromise = showPopup(new App(), "Test", {
      primaryButton: "Submit",
      inputs: [{ type: "text" }],
    });

    const container = document.querySelector(".systemsculpt-popup-container") as HTMLElement;
    const input = container?.querySelector("input") as HTMLInputElement;

    // Set a value in the input
    if (input) {
      input.value = "pasted-code";
    }

    // Press Enter
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    container?.dispatchEvent(event);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await resultPromise;

    expect(result?.confirmed).toBe(true);
    expect(result?.inputs?.[0]).toBe("pasted-code");
  });

  it("handles Escape key to cancel", async () => {
    const resultPromise = showPopup(new App(), "Test", {
      primaryButton: "Submit",
      secondaryButton: "Cancel",
    });

    const container = document.querySelector(".systemsculpt-popup-container") as HTMLElement;

    // Press Escape
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    container?.dispatchEvent(event);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await resultPromise;

    expect(result?.confirmed).toBe(false);
    expect(result?.action).toBe("cancel");
  });

  it("closes on background click", async () => {
    const resultPromise = showPopup(new App(), "Test", {
      primaryButton: "OK",
    });

    const container = document.querySelector(".systemsculpt-popup-container") as HTMLElement;

    // Click on the background (container itself, not the popup content)
    const event = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(event, "target", { value: container });
    container?.dispatchEvent(event);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await resultPromise;

    expect(result?.confirmed).toBe(false);
  });

  it("shows generic message with no OAuth-specific context (UX issue)", async () => {
    // The current OAuth popup shows:
    //   "Paste the authorization code or redirect URL:"
    // with a text input and Submit/Cancel buttons.
    //
    // Missing context that would help the user:
    // - Which provider they're authenticating with
    // - That a browser window should have opened
    // - That the callback server might handle it automatically
    // - What format the code should be in
    // - A timeout/progress indicator

    const resultPromise = showPopup(
      new App(),
      "Paste the authorization code or redirect URL:",
      {
        primaryButton: "Submit",
        secondaryButton: "Cancel",
        inputs: [{ type: "text", placeholder: "https://..." }],
      }
    );

    const container = document.querySelector(".systemsculpt-popup-container");
    const message = container?.querySelector(".systemsculpt-popup-message");
    const title = container?.querySelector(".systemsculpt-popup-title");
    const description = container?.querySelector(".systemsculpt-popup-description");

    // No title shown -- user doesn't know this is for OAuth
    expect(title).toBeNull();

    // No description -- user doesn't know what to do
    expect(description).toBeNull();

    // Generic message with no provider name
    expect(message?.textContent).toBe("Paste the authorization code or redirect URL:");
    expect(message?.textContent).not.toContain("OpenAI");
    expect(message?.textContent).not.toContain("ChatGPT");

    const cancelBtn = Array.from(container?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Cancel"
    );
    cancelBtn?.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await resultPromise;
  });
});
