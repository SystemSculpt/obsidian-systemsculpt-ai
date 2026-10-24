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
  };
});

jest.mock("../core/ui/modals/PromptModal", () => ({
  showPrompt: jest.fn(),
}));

jest.mock("../utils/clipboard", () => ({
  tryCopyToClipboard: jest.fn().mockResolvedValue(true),
}));

jest.mock("../platform/hostCapabilities", () => ({
  hasHostCapability: jest.fn(() => true),
}));

const mockOwnerWindow = {
  setTimeout: (callback: () => void) => { callback(); return 0; },
  location: { reload: jest.fn() },
};
jest.mock("../core/ui/surface/SurfaceDomContext", () => ({
  getSurfaceOwnerWindow: jest.fn(() => mockOwnerWindow),
}));

import { App, Notice } from "obsidian";
import { displayAdvancedTabContent } from "../settings/AdvancedTabContent";
import { hasHostCapability } from "../platform/hostCapabilities";
import { showPrompt } from "../core/ui/modals/PromptModal";
import { DEFAULT_SETTINGS } from "../types";

describe("Advanced settings tab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (hasHostCapability as jest.Mock).mockReturnValue(true);
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
      },
      getSettingsManager: jest.fn(() => ({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      })),
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
    expect(container.textContent).not.toContain("Update notifications");
    expect(container.textContent).not.toContain("Development mode");
  });

  it("exposes diagnostics recording as a toggle that is off by default", async () => {
    const app = new App();
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const container = document.createElement("div");
    const tab: any = {
      app,
      plugin: {
        settings: { showDiagnostics: false },
        getSettingsManager: jest.fn(() => ({ updateSettings })),
      },
      renderQuickActionsSection: jest.fn(),
    };

    displayAdvancedTabContent(container, tab);

    const setting = Array.from(container.querySelectorAll(".setting-item"))
      .find((item) => item.querySelector(".setting-item-name")?.textContent === "Record diagnostics");
    const toggle = setting?.querySelector<HTMLInputElement>("input.setting-item-toggle");
    expect(setting?.querySelector(".setting-item-description")?.textContent).toContain(".systemsculpt/diagnostics");
    expect(toggle?.checked).toBe(false);

    toggle!.checked = true;
    toggle!.dispatchEvent(new Event("change"));
    await Promise.resolve();

    expect(updateSettings).toHaveBeenCalledWith({ showDiagnostics: true });
  });

  it("does not render a dead file-manager action when the host cannot reveal folders", () => {
    (hasHostCapability as jest.Mock).mockReturnValue(false);
    const app = new App();
    const container = document.createElement("div");
    const tab: any = {
      app,
      plugin: {
        settings: {},
        getSettingsManager: jest.fn(() => ({
          updateSettings: jest.fn().mockResolvedValue(undefined),
        })),
      },
      renderQuickActionsSection: jest.fn(),
    };

    displayAdvancedTabContent(container, tab);

    expect(container.textContent).toContain("Diagnostics folder");
    expect(container.textContent).toContain(".systemsculpt/diagnostics");
    expect(Array.from(container.querySelectorAll("button")))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ textContent: "Open folder" }),
      ]));
  });

  function renderResetSetting() {
    const app = new App();
    const saveData = jest.fn().mockResolvedValue(undefined);
    const updateSettings = jest.fn().mockResolvedValue(true);
    const container = document.createElement("div");
    const tab: any = {
      app,
      plugin: { settings: {}, saveData, getSettingsManager: jest.fn(() => ({ updateSettings })) },
      renderQuickActionsSection: jest.fn(),
    };
    displayAdvancedTabContent(container, tab);
    const reset = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Reset…");
    expect(reset).toBeDefined();
    return { app, reset: reset!, saveData, updateSettings };
  }

  it.each([
    ["cancelled", null],
    ["declined", { confirmed: false }],
  ])("writes nothing and does not reload when the factory reset is %s", async (_label, answer) => {
    (showPrompt as jest.Mock).mockResolvedValue(answer);
    const { reset, saveData, updateSettings } = renderResetSetting();

    reset.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(saveData).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(mockOwnerWindow.location.reload).not.toHaveBeenCalled();
  });

  it("says what a factory reset replaces, then resets saved settings once and reloads once", async () => {
    (showPrompt as jest.Mock).mockResolvedValue({ confirmed: true });
    const { app, reset, saveData, updateSettings } = renderResetSetting();

    reset.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(showPrompt).toHaveBeenCalledWith(app, "Reset to Factory Defaults", {
      description: "Reset SystemSculpt’s saved settings to defaults and reload Obsidian? Your current settings will be replaced.",
      primaryButton: "Reset & Reload",
      secondaryButton: "Cancel",
    });
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(saveData).toHaveBeenCalledWith(null);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS });
    expect(mockOwnerWindow.location.reload).toHaveBeenCalledTimes(1);
  });
});
