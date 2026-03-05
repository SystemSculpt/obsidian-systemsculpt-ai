import { Setting } from "obsidian";
import { SYSTEMSCULPT_WEBSITE } from "../../constants/externalServices";
import { createExternalHelpLink } from "../uiHelpers";
import { SystemSculptSettingTab } from "../SystemSculptSettingTab";

export function renderSupportSection(
  root: HTMLElement,
  _tabInstance: SystemSculptSettingTab,
  _isProActive: boolean
): void {
  root.createEl("h3", { text: "Help & resources" });

  const linksSetting = new Setting(root)
    .setName("Documentation")
    .setDesc("Guides, troubleshooting, and ways to contact support.");

  const linkContainer = linksSetting.controlEl.createDiv({ cls: "ss-help-links" });
  createExternalHelpLink(linkContainer, {
    text: "Docs",
    href: SYSTEMSCULPT_WEBSITE.DOCS,
    ariaLabel: "Open the SystemSculpt documentation (opens in new tab)",
  });

  linkContainer.createSpan({ text: "•", cls: "ss-help-separator" });
  createExternalHelpLink(linkContainer, {
    text: "Support",
    href: SYSTEMSCULPT_WEBSITE.SUPPORT,
    ariaLabel: "Contact SystemSculpt support (opens in new tab)",
  });

  linkContainer.createSpan({ text: "•", cls: "ss-help-separator" });
  createExternalHelpLink(linkContainer, {
    text: "Report an issue",
    href: SYSTEMSCULPT_WEBSITE.FEEDBACK,
    ariaLabel: "Open the feedback form on GitHub (opens in new tab)",
  });

  const releaseSetting = new Setting(root)
    .setName("Release notes")
    .setDesc("See what changed in the latest release and the roadmap.");

  releaseSetting.addButton((button) => {
    button
      .setButtonText("View changelog")
      .onClick(() => window.open(`${SYSTEMSCULPT_WEBSITE.BASE_URL}/changelog`, "_blank"));
  });
}
