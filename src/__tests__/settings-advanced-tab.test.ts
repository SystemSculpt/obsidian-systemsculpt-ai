/** @jest-environment jsdom */

import { App } from "obsidian";
import { displayAdvancedTabContent } from "../settings/AdvancedTabContent";

describe("Advanced settings tab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders quick actions inside the advanced tab content", () => {
    const app = new App();
    const renderQuickActionsSection = jest.fn((containerEl: HTMLElement) => {
      const settingEl = document.createElement("div");
      settingEl.classList.add("setting-item");

      const nameEl = document.createElement("div");
      nameEl.classList.add("setting-item-name");
      nameEl.textContent = "Quick actions";
      settingEl.appendChild(nameEl);

      containerEl.appendChild(settingEl);
    });

    const plugin: any = {
      app,
      settings: {
        debugMode: false,
        showUpdateNotifications: true,
      },
      getSettingsManager: jest.fn(() => ({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      })),
      versionCheckerService: {
        onUpdateNotificationsDisabled: jest.fn(),
        onUpdateNotificationsEnabled: jest.fn(),
      },
    };

    const container = document.createElement("div");
    const tab: any = {
      app,
      plugin,
      renderQuickActionsSection,
    };

    displayAdvancedTabContent(container, tab);

    expect(renderQuickActionsSection).toHaveBeenCalledWith(container);
    expect(container.textContent).toContain("Quick actions");
    expect(container.textContent).toContain("Update notifications");
    expect(container.textContent).not.toContain("Development mode");
  });
});
