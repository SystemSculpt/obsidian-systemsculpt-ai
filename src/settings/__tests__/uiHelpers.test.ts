/**
 * @jest-environment jsdom
 */
import { setIcon } from "obsidian";

// This module only reaches for setIcon; the jest.fn lets the icon assertion
// below check which glyph was requested.
jest.mock("obsidian", () => ({
  setIcon: jest.fn(),
}));

import {
  createExternalHelpLink,
  decorateRestoreDefaultsButton,
  RESTORE_DEFAULTS_COPY,
} from "../uiHelpers";

describe("uiHelpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createExternalHelpLink", () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = document.createElement("div");
    });

    it("builds an external-link anchor in the container with safe target defaults", () => {
      const link = createExternalHelpLink(container, {
        text: "Help",
        href: "https://example.com/docs",
      });

      expect(link).toBeInstanceOf(HTMLAnchorElement);
      expect(container.contains(link)).toBe(true);
      expect(link.textContent).toContain("Help");
      expect(link.href).toBe("https://example.com/docs");
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
      expect(link.classList.contains("ss-help-link")).toBe(true);
      // Screen readers get the "opens in new tab" warning the visual target
      // attribute cannot convey.
      expect(link.getAttribute("aria-label")).toBe("Help (opens in new tab)");
      expect(link.title).toBe("Help (opens in new tab)");
      expect(link.dataset.testId).toBeUndefined();
      expect(link.querySelector(".ss-help-link-icon")).not.toBeNull();
      expect(setIcon).toHaveBeenCalledWith(expect.any(HTMLSpanElement), "external-link");
    });

    it("applies the optional class, aria-label, and test id", () => {
      const link = createExternalHelpLink(container, {
        text: "Help",
        href: "https://example.com",
        className: "custom-class",
        ariaLabel: "Custom label",
        datasetTestId: "help-link",
      });

      expect(link.classList.contains("ss-help-link")).toBe(true);
      expect(link.classList.contains("custom-class")).toBe(true);
      expect(link.getAttribute("aria-label")).toBe("Custom label");
      expect(link.title).toBe("Custom label");
      expect(link.dataset.testId).toBe("help-link");
    });

    it("creates the link and its icon in the container's own document", () => {
      // Settings can render into an Obsidian popout window, where elements
      // built from the main document would not be adoptable.
      const popoutDocument = document.implementation.createHTMLDocument("Obsidian popout");
      const popoutContainer = popoutDocument.createElement("div");

      const link = createExternalHelpLink(popoutContainer, {
        text: "Help",
        href: "https://example.com",
      });

      expect(link.ownerDocument).toBe(popoutDocument);
      expect(link.querySelector(".ss-help-link-icon")?.ownerDocument).toBe(popoutDocument);
    });
  });

  describe("decorateRestoreDefaultsButton", () => {
    it("labels the button from the shared copy without clobbering existing attributes", () => {
      const button = document.createElement("button");
      button.id = "my-button";
      button.type = "submit";

      const result = decorateRestoreDefaultsButton(button);

      expect(result).toBe(button);
      expect(button.textContent).toBe(RESTORE_DEFAULTS_COPY.label);
      expect(button.getAttribute("aria-label")).toBe(RESTORE_DEFAULTS_COPY.description);
      expect(button.title).toBe(RESTORE_DEFAULTS_COPY.description);
      expect(button.dataset.testId).toBe("restore-defaults-btn");
      expect(button.classList.contains("ss-restore-defaults-btn")).toBe(true);
      expect(button.id).toBe("my-button");
      expect(button.type).toBe("submit");
    });

    it("exposes the user-visible copy other surfaces reuse", () => {
      expect(RESTORE_DEFAULTS_COPY).toEqual({
        description: "Restore the recommended defaults",
        label: "Restore Recommended Defaults",
      });
    });
  });
});
