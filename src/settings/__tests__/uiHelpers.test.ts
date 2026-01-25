/**
 * @jest-environment jsdom
 */
import { setIcon } from "obsidian";

// Mock obsidian
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

    it("creates anchor element with correct text", () => {
      const link = createExternalHelpLink(container, {
        text: "Help",
        href: "https://example.com",
      });

      expect(link.textContent).toContain("Help");
      expect(link.tagName).toBe("A");
    });

    it("sets correct href", () => {
      const link = createExternalHelpLink(container, {
        text: "Help",
        href: "https://example.com/docs",
      });

      expect(link.href).toBe("https://example.com/docs");
    });

    it("opens in new tab", () => {
      const link = createExternalHelpLink(container, {
        text: "Help",
        href: "https://example.com",
      });

      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener");
    });

    it("adds base class", () => {
      const link = createExternalHelpLink(container, {
        text: "Help",
        href: "https://example.com",
      });

      expect(link.classList.contains("ss-help-link")).toBe(true);
    });

    it("adds custom class when provided", () => {
      const link = createExternalHelpLink(container, {
        text: "Help",
        href: "https://example.com",
        className: "custom-class",
      });

      expect(link.classList.contains("custom-class")).toBe(true);
    });

    it("sets default aria-label", () => {
      const link = createExternalHelpLink(container, {
        text: "Documentation",
        href: "https://example.com",
      });

      expect(link.getAttribute("aria-label")).toBe("Documentation (opens in new tab)");
      expect(link.title).toBe("Documentation (opens in new tab)");
    });

    it("uses custom aria-label when provided", () => {
      const link = createExternalHelpLink(container, {
        text: "Help",
        href: "https://example.com",
        ariaLabel: "Custom accessible label",
      });

      expect(link.getAttribute("aria-label")).toBe("Custom accessible label");
      expect(link.title).toBe("Custom accessible label");
    });

    it("sets data-test-id when provided", () => {
      const link = createExternalHelpLink(container, {
        text: "Help",
        href: "https://example.com",
        datasetTestId: "help-link",
      });

      expect(link.dataset.testId).toBe("help-link");
    });

    it("does not set data-test-id when not provided", () => {
      const link = createExternalHelpLink(container, {
        text: "Help",
        href: "https://example.com",
      });

      expect(link.dataset.testId).toBeUndefined();
    });

    it("appends link to container", () => {
      const link = createExternalHelpLink(container, {
        text: "Help",
        href: "https://example.com",
      });

      expect(container.contains(link)).toBe(true);
    });

    it("creates icon element with setIcon", () => {
      createExternalHelpLink(container, {
        text: "Help",
        href: "https://example.com",
      });

      expect(setIcon).toHaveBeenCalledWith(
        expect.any(HTMLSpanElement),
        "external-link"
      );
    });

    it("icon has correct class", () => {
      const link = createExternalHelpLink(container, {
        text: "Help",
        href: "https://example.com",
      });

      const icon = link.querySelector(".ss-help-link-icon");
      expect(icon).not.toBeNull();
    });

    it("returns the created anchor element", () => {
      const link = createExternalHelpLink(container, {
        text: "Help",
        href: "https://example.com",
      });

      expect(link).toBeInstanceOf(HTMLAnchorElement);
    });
  });

  describe("decorateRestoreDefaultsButton", () => {
    let button: HTMLButtonElement;

    beforeEach(() => {
      button = document.createElement("button");
    });

    it("sets button text", () => {
      decorateRestoreDefaultsButton(button);

      expect(button.textContent).toBe("Restore Recommended Defaults");
    });

    it("sets aria-label", () => {
      decorateRestoreDefaultsButton(button);

      expect(button.getAttribute("aria-label")).toBe("Restore the recommended defaults");
    });

    it("sets title", () => {
      decorateRestoreDefaultsButton(button);

      expect(button.title).toBe("Restore the recommended defaults");
    });

    it("sets data-test-id", () => {
      decorateRestoreDefaultsButton(button);

      expect(button.dataset.testId).toBe("restore-defaults-btn");
    });

    it("adds class", () => {
      decorateRestoreDefaultsButton(button);

      expect(button.classList.contains("ss-restore-defaults-btn")).toBe(true);
    });

    it("returns the decorated button", () => {
      const result = decorateRestoreDefaultsButton(button);

      expect(result).toBe(button);
    });

    it("preserves existing button attributes", () => {
      button.id = "my-button";
      button.type = "submit";

      decorateRestoreDefaultsButton(button);

      expect(button.id).toBe("my-button");
      expect(button.type).toBe("submit");
    });
  });

  describe("RESTORE_DEFAULTS_COPY", () => {
    it("has description", () => {
      expect(RESTORE_DEFAULTS_COPY.description).toBe("Restore the recommended defaults");
    });

    it("has label", () => {
      expect(RESTORE_DEFAULTS_COPY.label).toBe("Restore Recommended Defaults");
    });

    it("is readonly", () => {
      // TypeScript enforces this, but we can check the object exists
      expect(Object.keys(RESTORE_DEFAULTS_COPY)).toEqual(["description", "label"]);
    });
  });
});
