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

import { App, Notice } from "obsidian";
import { displayAdvancedTabContent } from "../settings/AdvancedTabContent";
import { hasHostCapability } from "../platform/hostCapabilities";

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
});
