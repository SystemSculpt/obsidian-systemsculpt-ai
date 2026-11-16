/** @jest-environment jsdom */
import { renderSupportSection } from "../setup/SetupTabSupportSection";
import type { SystemSculptSettingTab } from "../SystemSculptSettingTab";

describe("Patreon settings", () => {
  it.each([false, true])("links patrons to Pro activation and others to Patreon: pro=%s", (isProActive) => {
    const root = document.createElement("div");
    renderSupportSection(root, {} as SystemSculptSettingTab, isProActive);
    const activate = root.querySelector<HTMLAnchorElement>('[data-test-id="settings.patreon-activate"]')!;
    expect(activate.textContent).toBe("Activate Pro");
    expect(activate.href).toBe("https://systemsculpt.com/dashboard?utm_source=obsidian-plugin&utm_medium=plugin&utm_campaign=patreon_pro&utm_content=settings");
    const join = root.querySelector<HTMLAnchorElement>('[data-test-id="settings.patreon"]')!;
    expect(join.textContent).toBe("Join on Patreon");
    expect(join.href).toBe("https://www.patreon.com/SystemSculpt?utm_source=plugin_settings&utm_campaign=patreon_everywhere");
    for (const link of [activate, join]) {
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
    }
    expect(join.getAttribute("aria-label")).toBe("Join on Patreon (opens in new tab)");
    expect(root.textContent).toContain("Paid patrons get Pro.");
  });
});
