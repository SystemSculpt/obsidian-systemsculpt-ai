/** @jest-environment jsdom */

import { createExternalHelpLink, decorateRestoreDefaultsButton } from "../settings/uiHelpers";
import { setIcon } from "obsidian";

describe("settings UI helpers", () => {
  beforeEach(() => {
    (setIcon as jest.Mock).mockClear();
  });

  it("creates help links that indicate external navigation", () => {
    const root = document.createElement("div");

    const link = createExternalHelpLink(root, {
      text: "Documentation",
      href: "https://example.com/docs",
    });

    expect(link.tagName).toBe("A");
    expect(link.textContent).toContain("Documentation");
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener");

    expect(link.classList.contains("ss-help-link")).toBe(true);

    const icon = link.querySelector(".ss-help-link-icon");
    expect(icon).not.toBeNull();
    expect(setIcon).toHaveBeenCalledWith(icon, "external-link");
  });

  it("decorates restore defaults button with descriptive copy", () => {
    const button = document.createElement("button");

    decorateRestoreDefaultsButton(button);

    expect(button.textContent).toContain("Restore Recommended Defaults");
    const description = "Restore the recommended defaults";
    expect(button.getAttribute("aria-label")).toBe(description);
    expect(button.getAttribute("title")).toBe(description);
    expect(button.classList.contains("ss-restore-defaults-btn")).toBe(true);
  });
});
