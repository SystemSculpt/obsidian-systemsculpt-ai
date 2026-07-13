/** @jest-environment jsdom */

import { App } from "obsidian";
import { UpdateNotificationWarningModal } from "../UpdateNotificationWarningModal";

describe("UpdateNotificationWarningModal", () => {
  afterEach(() => document.body.empty());

  it("uses the shared accessible modal shell with concise copy", () => {
    const modal = new UpdateNotificationWarningModal(new App());
    void modal.open();

    expect(modal.modalEl.classList.contains("ss-modal")).toBe(true);
    expect(modal.modalEl.getAttribute("role")).toBe("dialog");
    expect(modal.modalEl.textContent).toContain("Disable update notifications");
    expect(modal.modalEl.textContent).toContain("compatibility updates");
    expect(modal.modalEl.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.type).toBe("button");
    expect(modal.modalEl.querySelector("ul")).toBeNull();
  });

  it("resolves false when cancelled", async () => {
    const modal = new UpdateNotificationWarningModal(new App());
    const result = modal.open();
    Array.from(modal.modalEl.querySelectorAll("button"))
      .find((button) => button.textContent === "Cancel")
      ?.click();

    await expect(result).resolves.toEqual({ confirmed: false });
  });

  it("resolves true from the destructive action", async () => {
    const modal = new UpdateNotificationWarningModal(new App());
    const result = modal.open();
    const disable = Array.from(modal.modalEl.querySelectorAll("button"))
      .find((button) => button.textContent === "Disable")!;

    expect(disable.classList.contains("mod-warning")).toBe(true);
    disable.click();
    await expect(result).resolves.toEqual({ confirmed: true });
  });
});
