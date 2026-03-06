import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { renderAccountSection } from "./setup/SetupTabAccountSection";
import {
  compareStudioPiAuthRecords,
  deriveStudioPiMigrationCandidates,
  renderLocalPiAuthSection,
  type StudioPiAuthMigrationCandidateSet,
  type StudioPiAuthMigrationSkip,
  type StudioPiAuthMigrationSkipReason,
} from "./setup/SetupTabPiAuthSection";
import { renderSupportSection } from "./setup/SetupTabSupportSection";

export type {
  StudioPiAuthMigrationCandidateSet,
  StudioPiAuthMigrationSkip,
  StudioPiAuthMigrationSkipReason,
};

export { compareStudioPiAuthRecords, deriveStudioPiMigrationCandidates };

export function displaySetupTabContent(
  containerEl: HTMLElement,
  tabInstance: SystemSculptSettingTab,
  isProActive: boolean
): void {
  containerEl.empty();
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "setup";
  }

  renderAccountSection(containerEl, tabInstance, isProActive);
  renderLocalPiAuthSection(containerEl, tabInstance);
  renderSupportSection(containerEl, tabInstance, isProActive);
}
