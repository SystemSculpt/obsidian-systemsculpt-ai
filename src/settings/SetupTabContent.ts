import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { renderAccountSection } from "./setup/SetupTabAccountSection";
import { renderSupportSection } from "./setup/SetupTabSupportSection";

export function displaySetupTabContent(
  containerEl: HTMLElement,
  tabInstance: SystemSculptSettingTab,
  isProActive: boolean
): void {
  containerEl.empty();
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "account";
  }

  renderAccountSection(containerEl, tabInstance, isProActive);
  renderSupportSection(containerEl, tabInstance, isProActive);
}
