/** @jest-environment jsdom */

import { SystemSculptSettingTab } from "../settings/SystemSculptSettingTab";
import { App, Platform } from "obsidian";
import { buildSettingsTabConfigs } from "../settings/SettingsTabRegistry";

jest.mock("../settings/SettingsTabRegistry", () => ({
  buildSettingsTabConfigs: jest.fn(() => [
    {
      id: "account",
      label: "Account",
      sections: [
        (parent: HTMLElement) => {
          const setting = parent.createDiv({ cls: "setting-item" });
          setting.createDiv({
            cls: "setting-item-name",
            text: "Account access",
          });
          setting.createDiv({
            cls: "setting-item-description",
            text: "Manage your SystemSculpt account access.",
          });
        },
      ],
    },
  ]),
}));

jest.mock("../core/ui/modals/PromptModal", () => ({
  showPrompt: jest.fn(),
}));

const createPluginStub = () => {
  const settingsManager = {
    updateSettings: jest.fn().mockResolvedValue(undefined),
  };

  return {
    manifest: { version: "1.2.3" },
    settings: {
      settingsMode: "standard",
      licenseValid: false,
      customProviders: [],
      activeProvider: null,
      selectedModelId: "",
      embeddingsEnabled: false,
      enableSystemSculptProvider: false,
      useSystemSculptAsFallback: false,
      chatsDirectory: "",
      savedChatsDirectory: "",
      attachmentsDirectory: "",
      extractionsDirectory: "",
      debugMode: false,
      useLatestModelEverywhere: true,
      licenseKey: "",
      subscriptionStatus: "",
    },
    getSettingsManager: jest.fn(() => settingsManager),
    getSettingsManagerInstance: settingsManager,
    emitter: {
      on: jest.fn(),
      off: jest.fn(),
      emit: jest.fn(),
    },
    modelService: {
      getModels: jest.fn().mockResolvedValue([]),
      refreshModels: jest.fn(),
    },
    customProviderService: {
      clearCache: jest.fn(),
    },
  } as any;
};

describe("SystemSculptSettingTab native layout", () => {
  let app: App;
  let scrollIntoViewMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    (buildSettingsTabConfigs as jest.Mock).mockReturnValue([
      {
        id: "account",
        label: "Account",
        sections: [
          (parent: HTMLElement) => {
            const setting = parent.createDiv({ cls: "setting-item" });
            setting.createDiv({
              cls: "setting-item-name",
              text: "Account access",
            });
            setting.createDiv({
              cls: "setting-item-description",
              text: "Manage your SystemSculpt account access.",
            });
          },
        ],
      },
    ]);
    app = new App();
    scrollIntoViewMock = jest.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });
    if (!(app.workspace as any).offref) {
      Object.defineProperty(app.workspace, "offref", {
        value: jest.fn(),
        writable: true,
      });
    }
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const renderTab = async () => {
    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    await tab.display();
    return tab;
  };

  it("does not opt into incomplete declarative settings on Obsidian 1.13+", () => {
    expect("getSettingDefinitions" in SystemSculptSettingTab.prototype).toBe(false);
  });

  it("does not inject legacy style tag", async () => {
    await renderTab();
    expect(document.getElementById("systemsculpt-settings-styles")).toBeNull();
  });

  it("mounts the canonical view surface and shared search field", async () => {
    const tab = await renderTab();
    const surface = tab.containerEl.querySelector(".ss-settings-surface");
    const searchInput = tab.containerEl.querySelector("input[type='search']");

    expect(surface?.classList.contains("ss-surface")).toBe(true);
    expect(surface?.getAttribute("data-ss-surface")).toBe("view");
    expect(searchInput).not.toBeNull();
    const nativeSearchContainer = searchInput?.closest(".search-input-container");
    expect(nativeSearchContainer).not.toBeNull();
    expect(nativeSearchContainer?.parentElement?.classList.contains("ss-search-field")).toBe(true);
    expect(tab.containerEl.querySelector(".search-input-clear-button")).not.toBeNull();
    expect(tab.containerEl.querySelector(".ss-search-field__icon")).toBeNull();
    expect(
      tab.containerEl.querySelector(".ss-settings-search-shell"),
    ).not.toBeNull();
  });

  it("uses streamlined tab bar classes", async () => {
    const tab = await renderTab();
    expect(
      tab.containerEl.querySelector(".systemsculpt-settings-tabs"),
    ).toBeNull();
    expect(
      tab.containerEl.querySelector(".ss-settings-tab-bar"),
    ).not.toBeNull();
  });

  it("keeps the settings introduction terse and first-party", async () => {
    const tab = await renderTab();
    const text = tab.containerEl.textContent || "";
    expect(text).toContain("Account, workspace, and vault preferences.");
    expect(text).not.toContain("Configure AI models");
  });

  it("shows the plugin version without duplicating Obsidian's settings title", async () => {
    const tab = await renderTab();
    const titleRow = tab.containerEl.querySelector(".ss-settings-title-row");
    const title = titleRow?.querySelector("h2");
    const version = titleRow?.querySelector(".ss-settings-title-version");

    expect(title).toBeNull();
    expect(version?.textContent).toBe("v1.2.3");
    expect(titleRow?.querySelector('button[aria-label="Check for updates"]')).toBeNull();
    expect(
      Array.from(tab.containerEl.querySelectorAll(".setting-item-name")).some(
        (el) => el.textContent?.trim() === "Plugin version",
      ),
    ).toBe(false);
  });

  it("does not render the legacy settings mode control", async () => {
    const tab = await renderTab();
    const text = tab.containerEl.textContent || "";

    expect(text).not.toContain("Settings mode");
    expect(
      Array.from(tab.containerEl.querySelectorAll(".setting-item-name")).some(
        (el) => el.textContent?.trim() === "Settings mode",
      ),
    ).toBe(false);
  });

  it("keeps quick actions out of the top-level settings shell", async () => {
    const tab = await renderTab();
    expect(
      Array.from(tab.containerEl.querySelectorAll(".setting-item-name")).some(
        (el) => el.textContent?.trim() === "Quick actions",
      ),
    ).toBe(false);
  });

  it("builds feedback payloads around SystemSculpt access instead of provider choices", () => {
    const plugin = createPluginStub();
    plugin.settings.licenseValid = true;
    plugin.settings.licenseKey = "license_test";
    plugin.settings.selectedModelId = "openai@@gpt-4.1";
    plugin.settings.customProviders = [
      { name: "Legacy Provider", isEnabled: true },
    ];

    const tab = new SystemSculptSettingTab(app, plugin);
    const url = (tab as any).generateFeedbackUrl();
    const body = decodeURIComponent(url.split("&body=")[1] || "");

    expect(body).toContain("SystemSculpt access: Active");
    expect(body).not.toContain("AI Provider:");
    expect(body).not.toContain("AI Model:");
    expect(body).not.toContain("Custom providers enabled:");
  });

  it("reports the mobile app host in feedback diagnostics", () => {
    const platform = Platform as typeof Platform & {
      isDesktopApp?: boolean;
      isMobile?: boolean;
      isMobileApp?: boolean;
    };
    const previous = {
      isDesktopApp: platform.isDesktopApp,
      isMobile: platform.isMobile,
      isMobileApp: platform.isMobileApp,
    };
    platform.isDesktopApp = false;
    platform.isMobile = true;
    platform.isMobileApp = true;
    try {
      const tab = new SystemSculptSettingTab(app, createPluginStub());
      const url = (tab as any).generateFeedbackUrl();
      const body = decodeURIComponent(url.split("&body=")[1] || "");

      expect(body).toContain("Device type: Mobile");
    } finally {
      platform.isDesktopApp = previous.isDesktopApp;
      platform.isMobile = previous.isMobile;
      platform.isMobileApp = previous.isMobileApp;
    }
  });

  it("preserves active tab across settings rerenders", async () => {
    (buildSettingsTabConfigs as jest.Mock).mockReturnValue([
      {
        id: "account",
        label: "Account",
        sections: [
          (parent: HTMLElement) => {
            parent.createDiv({ cls: "setting-item", text: "Account item" });
          },
        ],
      },
      {
        id: "knowledge",
        label: "Knowledge",
        sections: [
          (parent: HTMLElement) => {
            parent.createDiv({ cls: "setting-item", text: "Knowledge item" });
          },
        ],
      },
    ]);

    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    await tab.display();

    const knowledgeButton = tab.containerEl.querySelector(
      'button[data-tab="knowledge"]',
    ) as HTMLElement | null;
    expect(knowledgeButton).not.toBeNull();
    knowledgeButton?.click();

    await tab.display();

    const knowledgeButtonAfter = tab.containerEl.querySelector(
      'button[data-tab="knowledge"]',
    ) as HTMLElement | null;
    const knowledgePanelAfter = tab.containerEl.querySelector(
      '.systemsculpt-tab-content[data-tab="knowledge"]',
    ) as HTMLElement | null;

    expect(knowledgeButtonAfter?.classList.contains("is-selected")).toBe(true);
    expect(knowledgeButtonAfter?.getAttribute("role")).toBe("tab");
    expect(knowledgeButtonAfter?.getAttribute("aria-selected")).toBe("true");
    expect(knowledgeButtonAfter?.hasAttribute("aria-pressed")).toBe(false);
    expect(knowledgePanelAfter?.classList.contains("is-active")).toBe(true);
    expect(knowledgePanelAfter?.getAttribute("role")).toBe("tabpanel");
  });

  it("invalidates registered render work on rerender and hide", async () => {
    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    const rerenderCleanup = jest.fn();
    const hideCleanup = jest.fn();

    tab.registerRenderCleanup(rerenderCleanup);
    await tab.display();
    expect(rerenderCleanup).toHaveBeenCalledTimes(1);

    tab.registerRenderCleanup(hideCleanup);
    tab.hide();
    expect(hideCleanup).toHaveBeenCalledTimes(1);
  });

  it("cancels delayed settings indexing when the surface hides", async () => {
    jest.useFakeTimers();
    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    const buildSettingsIndex = jest.spyOn(tab as any, "buildSettingsIndex");

    await tab.display();
    expect(buildSettingsIndex).toHaveBeenCalledTimes(1);

    tab.hide();
    jest.advanceTimersByTime(500);

    expect(buildSettingsIndex).toHaveBeenCalledTimes(1);
  });

  it("honors a queued providers focus request during initial render", async () => {
    (buildSettingsTabConfigs as jest.Mock).mockReturnValue([
      {
        id: "account",
        label: "Account",
        sections: [
          (parent: HTMLElement) => {
            parent.createDiv({ cls: "setting-item", text: "Account item" });
          },
        ],
      },
      {
        id: "providers",
        label: "Providers",
        sections: [
          (parent: HTMLElement) => {
            parent.createDiv({ cls: "setting-item", text: "Providers item" });
          },
        ],
      },
    ]);

    const plugin = createPluginStub();
    plugin.consumePendingSettingsFocusTab = jest.fn(() => "providers");
    plugin.clearPendingSettingsFocusTab = jest.fn();

    const tab = new SystemSculptSettingTab(app, plugin);
    await tab.display();

    const providersButton = tab.containerEl.querySelector(
      'button[data-tab="providers"]',
    ) as HTMLElement | null;
    const providersPanel = tab.containerEl.querySelector(
      '.systemsculpt-tab-content[data-tab="providers"]',
    ) as HTMLElement | null;
    const accountPanel = tab.containerEl.querySelector(
      '.systemsculpt-tab-content[data-tab="account"]',
    ) as HTMLElement | null;

    expect(plugin.consumePendingSettingsFocusTab).toHaveBeenCalledTimes(1);
    expect(providersButton?.classList.contains("is-selected")).toBe(true);
    expect(providersPanel?.classList.contains("is-active")).toBe(true);
    expect(accountPanel?.classList.contains("is-active")).toBe(false);
  });

  it("renders grouped search results with highlighted matches and keyboard guidance", async () => {
    (buildSettingsTabConfigs as jest.Mock).mockReturnValue([
      {
        id: "account",
        label: "Account",
        sections: [
          (parent: HTMLElement) => {
            const setting = parent.createDiv({ cls: "setting-item" });
            setting.createDiv({
              cls: "setting-item-name",
              text: "Provider connections",
            });
            setting.createDiv({
              cls: "setting-item-description",
              text: "Manage auth and local runtimes.",
            });
          },
        ],
      },
      {
        id: "knowledge",
        label: "Knowledge",
        sections: [
          (parent: HTMLElement) => {
            const setting = parent.createDiv({ cls: "setting-item" });
            setting.createDiv({
              cls: "setting-item-name",
              text: "Provider fallback",
            });
            setting.createDiv({
              cls: "setting-item-description",
              text: "Choose the backup provider for embeddings.",
            });
          },
        ],
      },
    ]);

    const tab = await renderTab();
    const searchInput = tab.containerEl.querySelector(
      "input[type='search']",
    ) as HTMLInputElement;
    searchInput.value = "provider";
    searchInput.dispatchEvent(new Event("input"));

    const metaText =
      tab.containerEl.querySelector(".ss-settings-search-meta")?.textContent ||
      "";
    const groupTitles = Array.from(
      tab.containerEl.querySelectorAll(".ss-search-group__title"),
    ).map((el) => el.textContent?.trim());

    expect(metaText).toContain("2 results");
    expect(metaText).toContain("“provider”");
    expect(metaText).toContain("Enter");
    expect(groupTitles).toHaveLength(2);
    expect(groupTitles).toEqual(
      expect.arrayContaining(["Account", "Knowledge"]),
    );
    expect(
      tab.containerEl.querySelectorAll("mark.ss-search-mark").length,
    ).toBeGreaterThan(0);
    expect(tab.containerEl.querySelector(".search-input-clear-button")).not.toBeNull();
  });

  it("shows a polished empty state and clears through the native search control", async () => {
    const tab = await renderTab();
    const searchInput = tab.containerEl.querySelector(
      "input[type='search']",
    ) as HTMLInputElement;
    searchInput.value = "definitely-not-a-setting";
    searchInput.dispatchEvent(new Event("input"));

    expect(
      tab.containerEl.querySelector(".ss-ui-state.is-empty .ss-ui-state__title")
        ?.textContent,
    ).toContain("No settings found");

    searchInput.value = "";
    searchInput.dispatchEvent(new Event("input"));

    expect(searchInput.value).toBe("");
    expect(tab.containerEl.querySelector(".ss-ui-state.is-empty")).toBeNull();
    expect(
      tab.containerEl.querySelector(".ss-settings-search-meta")?.textContent,
    ).toContain("settings in");
  });

  it("clears settings search and restores tabs when Escape is pressed", async () => {
    const tab = await renderTab();
    const searchInput = tab.containerEl.querySelector(
      "input[type='search']",
    ) as HTMLInputElement;
    const tabBar = tab.containerEl.querySelector(
      ".ss-settings-tab-bar",
    ) as HTMLElement;
    const results = tab.containerEl.querySelector(
      ".ss-settings-search-results",
    ) as HTMLElement;
    const focus = jest.spyOn(searchInput, "focus");

    searchInput.value = "account";
    searchInput.dispatchEvent(new Event("input"));
    expect(searchInput.getAttribute("aria-expanded")).toBe("true");
    expect(tabBar.hidden).toBe(true);
    expect(results.hidden).toBe(false);
    focus.mockClear();

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    searchInput.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(true);
    expect(searchInput.value).toBe("");
    expect(searchInput.getAttribute("aria-expanded")).toBe("false");
    expect(tabBar.hidden).toBe(false);
    expect(results.hidden).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);

    searchInput.value = "account";
    searchInput.dispatchEvent(new Event("input"));
    expect(searchInput.getAttribute("aria-expanded")).toBe("true");
    expect(results.hidden).toBe(false);
  });

  it("supports keyboard selection and enter-to-jump for search results", async () => {
    jest.useFakeTimers();
    (buildSettingsTabConfigs as jest.Mock).mockReturnValue([
      {
        id: "account",
        label: "Account",
        sections: [
          (parent: HTMLElement) => {
            const setting = parent.createDiv({ cls: "setting-item" });
            setting.createDiv({
              cls: "setting-item-name",
              text: "Provider connections",
            });
            setting.createDiv({
              cls: "setting-item-description",
              text: "Manage provider auth.",
            });
          },
        ],
      },
      {
        id: "knowledge",
        label: "Knowledge",
        sections: [
          (parent: HTMLElement) => {
            const setting = parent.createDiv({ cls: "setting-item" });
            setting.createDiv({
              cls: "setting-item-name",
              text: "Provider fallback",
            });
            setting.createDiv({
              cls: "setting-item-description",
              text: "Choose the backup provider.",
            });
          },
        ],
      },
    ]);

    const tab = await renderTab();
    const searchInput = tab.containerEl.querySelector(
      "input[type='search']",
    ) as HTMLInputElement;
    searchInput.value = "provider";
    searchInput.dispatchEvent(new Event("input"));

    let searchRows = Array.from(
      tab.containerEl.querySelectorAll(".ss-search-result"),
    );
    expect(searchRows[0].classList.contains("is-selected")).toBe(true);
    expect(searchInput.getAttribute("role")).toBe("combobox");
    expect(searchInput.getAttribute("aria-activedescendant")).toBe(searchRows[0].id);
    expect(searchRows[0].getAttribute("role")).toBe("option");

    searchInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown" }),
    );
    searchRows = Array.from(
      tab.containerEl.querySelectorAll(".ss-search-result"),
    );
    expect(searchRows[1].classList.contains("is-selected")).toBe(true);
    expect(searchInput.getAttribute("aria-activedescendant")).toBe(searchRows[1].id);
    const selectedResultText = searchRows[1].textContent || "";

    searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    jest.advanceTimersByTime(60);

    const expectedTabId = selectedResultText.includes("Provider fallback")
      ? "knowledge"
      : "account";
    const expectedSettingTitle = selectedResultText.includes(
      "Provider fallback",
    )
      ? "Provider fallback"
      : "Provider connections";
    const expectedTabButton = tab.containerEl.querySelector(
      `button[data-tab="${expectedTabId}"]`,
    );
    const highlightedSetting = Array.from(
      tab.containerEl.querySelectorAll(".setting-item"),
    ).find((item) => item.textContent?.includes(expectedSettingTitle));

    expect(searchInput.value).toBe("");
    expect(expectedTabButton?.classList.contains("is-selected")).toBe(true);
    expect(highlightedSetting?.classList.contains("ss-search-highlight")).toBe(
      true,
    );
    expect(scrollIntoViewMock).toHaveBeenCalled();

    jest.useRealTimers();
  });
});
