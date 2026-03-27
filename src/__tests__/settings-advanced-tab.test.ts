/** @jest-environment jsdom */

jest.mock("obsidian", () => {
  class App {}

  class ButtonComponent {
    buttonEl: HTMLButtonElement;

    constructor(containerEl: HTMLElement) {
      this.buttonEl = document.createElement("button");
      containerEl.appendChild(this.buttonEl);
    }

    setButtonText(text: string) {
      this.buttonEl.textContent = text;
      return this;
    }

    setWarning() {
      this.buttonEl.dataset.warning = "true";
      return this;
    }

    onClick(callback: () => void) {
      this.buttonEl.addEventListener("click", callback);
      return this;
    }
  }

  class Setting {
    settingEl: HTMLDivElement;
    controlEl: HTMLDivElement;

    constructor(containerEl: HTMLElement) {
      this.settingEl = document.createElement("div");
      this.settingEl.className = "setting-item";
      const infoEl = document.createElement("div");
      infoEl.className = "setting-item-info";
      this.controlEl = document.createElement("div");
      this.controlEl.className = "setting-item-control";
      this.settingEl.appendChild(infoEl);
      this.settingEl.appendChild(this.controlEl);
      containerEl.appendChild(this.settingEl);
    }

    setName(name: string) {
      const nameEl = document.createElement("div");
      nameEl.className = "setting-item-name";
      nameEl.textContent = name;
      this.settingEl.querySelector(".setting-item-info")?.appendChild(nameEl);
      return this;
    }

    setDesc(description: string) {
      const descEl = document.createElement("div");
      descEl.className = "setting-item-description";
      descEl.textContent = description;
      this.settingEl.querySelector(".setting-item-info")?.appendChild(descEl);
      return this;
    }

    addToggle(builder: (toggle: { setValue: (value: boolean) => any; onChange: (callback: (value: boolean) => void) => any }) => void) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "setting-item-toggle";
      this.controlEl.appendChild(input);

      const toggle = {
        setValue: (value: boolean) => {
          input.checked = Boolean(value);
          return toggle;
        },
        onChange: (callback: (value: boolean) => void) => {
          input.addEventListener("change", () => {
            void callback(input.checked);
          });
          return toggle;
        },
      };

      builder(toggle);
      return this;
    }

    addButton(builder: (button: ButtonComponent) => void) {
      builder(new ButtonComponent(this.controlEl));
      return this;
    }
  }

  return {
    App,
    ButtonComponent,
    Setting,
    Notice: jest.fn(),
    Platform: {
      isDesktopApp: true,
    },
  };
});

jest.mock("../core/ui", () => ({
  showPopup: jest.fn(),
}));

jest.mock("../modals/UpdateNotificationWarningModal", () => ({
  UpdateNotificationWarningModal: jest.fn().mockImplementation(() => ({
    open: jest.fn().mockResolvedValue({ confirmed: true }),
  })),
}));

jest.mock("../utils/clipboard", () => ({
  tryCopyToClipboard: jest.fn().mockResolvedValue(true),
}));

import { App, Notice } from "obsidian";
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
        desktopAutomationBridgeEnabled: false,
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
    expect(container.textContent).toContain("Desktop automation bridge");
    expect(container.textContent).not.toContain("Development mode");
  });

  it("updates desktop automation bridge settings from the advanced tab toggle", async () => {
    const app = new App();
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const plugin: any = {
      app,
      settings: {
        debugMode: false,
        showUpdateNotifications: true,
        desktopAutomationBridgeEnabled: false,
      },
      getSettingsManager: jest.fn(() => ({
        updateSettings,
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
      renderQuickActionsSection: jest.fn(),
    };

    displayAdvancedTabContent(container, tab);

    const toggle = Array.from(container.querySelectorAll("input[type='checkbox']")).find((input) => {
      const setting = input.closest(".setting-item");
      return setting?.textContent?.includes("Desktop automation bridge");
    }) as HTMLInputElement | undefined;

    expect(toggle).toBeDefined();
    toggle!.checked = true;
    toggle!.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();

    expect(updateSettings).toHaveBeenCalledWith({
      desktopAutomationBridgeEnabled: true,
    });
    expect(Notice).toHaveBeenCalledWith("Desktop automation bridge enabled.");
  });
});
