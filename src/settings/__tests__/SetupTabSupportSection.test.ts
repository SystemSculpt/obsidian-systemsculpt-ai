/** @jest-environment jsdom */
import { renderSupportSection } from "../setup/SetupTabSupportSection";
import type { SystemSculptSettingTab } from "../SystemSculptSettingTab";

describe("Patreon support settings", () => {
  it.each([false, true])("offers safe attributed support without a plan requirement: pro=%s", (isProActive) => {
    const root = document.createElement("div");
    renderSupportSection(root, {} as SystemSculptSettingTab, isProActive);
    const link = root.querySelector<HTMLAnchorElement>('[data-test-id="settings.patreon"]')!;
    expect(link.textContent).toContain("Support us on Patreon");
    expect(link.href).toBe("https://www.patreon.com/SystemSculpt?utm_source=plugin_settings&utm_campaign=patreon_everywhere");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(link.getAttribute("aria-label")).toBe("Support us on Patreon (opens in new tab)");
    expect(root.textContent).not.toMatch(/Patreon.*(?:Pro|license)/);
  });
});
