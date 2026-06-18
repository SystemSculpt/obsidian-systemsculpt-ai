import {
  App,
  PluginSettingTab,
  Setting,
  Notice,
  setIcon,
  Platform,
  EventRef,
} from "obsidian";
import { SYSTEMSCULPT_WEBSITE } from "../constants/externalServices";
import { showPopup } from "../core/ui";
import SystemSculptPlugin from "../main";
import { VersionInfo } from "../services/VersionCheckerService";
import {
  buildSettingsIndexFromRoot,
  buildSettingsSearchHighlightParts,
  searchSettingsIndex,
  type SettingsIndexEntry,
  type SettingsSearchGroup,
  type SettingsSearchMatch,
} from "./SettingsSearchIndex";
import { buildSettingsTabConfigs } from "./SettingsTabRegistry";
import {
  decorateRestoreDefaultsButton,
  RESTORE_DEFAULTS_COPY,
} from "./uiHelpers";

type SettingsSearchViewState = {
  query: string;
  groups: SettingsSearchGroup[];
  results: SettingsSearchMatch[];
  selectedIndex: number;
};

export class SystemSculptSettingTab extends PluginSettingTab {
  plugin: SystemSculptPlugin;
  private listeners: {
    element: HTMLElement;
    type: string;
    listener: EventListener;
  }[] = [];
  private versionInfoContainer: HTMLElement | null = null;
  private tabContainerEl: HTMLElement | null = null;
  private contentContainerEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private searchShellEl: HTMLElement | null = null;
  private searchMetaEl: HTMLElement | null = null;
  private clearSearchButtonEl: HTMLButtonElement | null = null;
  private searchResultsContainerEl: HTMLElement | null = null;
  private allSettingsIndex: SettingsIndexEntry[] = [];
  private tabsDef: { id: string; label: string }[] = [];
  private contentMutationObserver: MutationObserver | null = null;
  private indexRebuildTimer: number | null = null;
  private activeTabId: string = "account";
  private focusTabEventRef: EventRef | null = null;
  private searchState: SettingsSearchViewState = {
    query: "",
    groups: [],
    results: [],
    selectedIndex: -1,
  };
  private readonly searchResultsListId = "systemsculpt-settings-search-results";

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  registerListener(
    element: HTMLElement,
    type: string,
    listener: EventListener,
  ) {
    element.addEventListener(type, listener);
    this.listeners.push({ element, type, listener });
  }

  private generateFeedbackUrl(): string {
    const environmentInfo: string[] = [];

    // Plugin version - always available
    environmentInfo.push(
      `- SystemSculpt AI version: ${this.plugin.manifest.version}`,
    );

    // Obsidian version
    const obsidianVersion =
      (this.app as any).apiVersion ||
      (this.app as any).vault?.config?.version ||
      "";
    if (obsidianVersion) {
      environmentInfo.push(`- Obsidian version: ${obsidianVersion}`);
    }

    // OS
    let os = "";
    if (Platform.isWin) {
      os = "Windows";
    } else if (Platform.isMacOS) {
      os = "macOS";
    } else if (Platform.isLinux) {
      os = "Linux";
    } else if (Platform.isIosApp) {
      os = "iOS";
    } else if (Platform.isAndroidApp) {
      os = "Android";
    }
    if (os) {
      environmentInfo.push(`- OS: ${os}`);
    }

    // Device type
    let deviceType = "";
    if (Platform.isDesktopApp) {
      deviceType = "Desktop";
    } else if (Platform.isMobileApp) {
      deviceType = "Mobile";
    } else if (Platform.isTablet) {
      deviceType = "Tablet";
    }
    if (deviceType) {
      environmentInfo.push(`- Device type: ${deviceType}`);
    }

    // Theme
    const isDarkTheme = document.body.classList.contains("theme-dark");
    environmentInfo.push(`- Theme: ${isDarkTheme ? "Dark" : "Light"}`);

    // Language/Locale
    if (navigator.language) {
      environmentInfo.push(`- Language: ${navigator.language}`);
    }

    const hasSystemSculptAccess = !!(
      this.plugin.settings.licenseValid === true &&
      this.plugin.settings.licenseKey?.trim()
    );
    environmentInfo.push(
      `- SystemSculpt access: ${hasSystemSculptAccess ? "Active" : "Needs setup"}`,
    );
    environmentInfo.push("- Execution path: SystemSculpt");

    // Vault Statistics (privacy-conscious)
    const files = this.app.vault.getFiles();
    const noteCount = files.filter((f) => f.extension === "md").length;
    let vaultSize = "";
    if (noteCount < 100) vaultSize = "Small (<100 notes)";
    else if (noteCount < 500) vaultSize = "Medium (100-500 notes)";
    else if (noteCount < 2000) vaultSize = "Large (500-2000 notes)";
    else vaultSize = "Very Large (2000+ notes)";
    environmentInfo.push(`- Vault size: ${vaultSize}`);

    // Enabled Features
    const enabledFeatures: string[] = ["MCP"]; // MCP is always enabled (internal servers)
    if (this.plugin.settings.embeddingsEnabled)
      enabledFeatures.push("Embeddings");

    if (enabledFeatures.length > 0) {
      environmentInfo.push(`- Enabled features: ${enabledFeatures.join(", ")}`);
    }

    const title = encodeURIComponent("SystemSculpt Feedback: ");
    const body = encodeURIComponent(
      `Please describe your feedback:\n\n` +
        `- What happened or what would you like to see improved?\n` +
        `- Steps to reproduce (if a bug):\n` +
        `- Expected behavior:\n` +
        `- Screenshots or logs:\n\n` +
        `Environment:\n` +
        environmentInfo.join("\n") +
        "\n\n" +
        `Additional context:`,
    );

    return `https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues/new?title=${title}&body=${body}`;
  }

  public renderQuickActionsSection(containerEl: HTMLElement): void {
    const actionsSetting = new Setting(containerEl)
      .setName("Quick actions")
      .setDesc("");

    actionsSetting.addButton((button) => {
      decorateRestoreDefaultsButton(button.buttonEl);
      button.onClick(async () => {
        const confirm = await showPopup(this.app, RESTORE_DEFAULTS_COPY.label, {
          description:
            "This will replace your current configuration with the recommended defaults. Any customizations you've applied will be overwritten. Do you want to continue?",
          primaryButton: "Restore Defaults",
          secondaryButton: "Cancel",
        });
        if (!confirm?.confirmed) {
          return;
        }

        try {
          button.setDisabled(true);
          await this.plugin.getSettingsManager().updateSettings({
            chatFontSize: "medium",
            embeddingsEnabled: false,
            chatsDirectory: "SystemSculpt/Chats",
            savedChatsDirectory: "SystemSculpt/Saved Chats",
            attachmentsDirectory: "SystemSculpt/Attachments",
            extractionsDirectory: "SystemSculpt/Extractions",
            showUpdateNotifications: true,
            debugMode: false,
          });
          new Notice("Recommended defaults restored.", 2500);
          await this.display();
        } catch (_) {
          new Notice("Failed to restore recommended defaults.", 4000);
        } finally {
          button.setDisabled(false);
        }
      });
    });

    const feedbackLink = actionsSetting.controlEl.createEl("a", {
      cls: "ss-settings-link",
      text: "Send feedback",
      attr: {
        href: this.generateFeedbackUrl(),
        target: "_blank",
        rel: "noopener",
        "aria-label": "Share feedback, report bugs, or suggest improvements",
      },
    });
    setIcon(
      feedbackLink.createSpan({ cls: "ss-settings-link-icon" }),
      "external-link",
    );
  }

  private removeAllListeners() {
    this.listeners.forEach(({ element, type, listener }) => {
      element.removeEventListener(type, listener);
    });
    this.listeners = [];
  }

  async display(): Promise<void> {
    this.removeAllListeners();
    const { containerEl } = this;
    containerEl.empty();

    this.tabContainerEl = null;
    this.contentContainerEl = null;
    this.searchInputEl = null;
    this.searchShellEl = null;
    this.searchMetaEl = null;
    this.clearSearchButtonEl = null;
    this.searchResultsContainerEl = null;
    this.searchState = {
      query: "",
      groups: [],
      results: [],
      selectedIndex: -1,
    };

    const titleRow = containerEl.createDiv({ cls: "ss-settings-title-row" });
    const titleGroup = titleRow.createDiv({ cls: "ss-settings-title-group" });
    titleGroup.createEl("h2", { text: "SystemSculpt AI" });
    const titleMeta = titleGroup.createDiv({ cls: "ss-settings-title-meta" });
    this.versionInfoContainer = titleMeta.createDiv({
      cls: "ss-settings-title-version",
    });
    this.initializeVersionDisplay();

    const refreshVersionButton = titleMeta.createEl("button", {
      cls: "clickable-icon ss-settings-title-refresh",
      attr: {
        type: "button",
        "aria-label": "Check for updates",
        title: "Check for updates",
      },
    });
    setIcon(refreshVersionButton, "refresh-cw");
    this.registerListener(refreshVersionButton, "click", async () => {
      refreshVersionButton.disabled = true;
      try {
        await this.checkForUpdates(true);
      } finally {
        refreshVersionButton.disabled = false;
      }
    });

    containerEl.createEl("p", {
      text: "Manage your SystemSculpt account, workspace preferences, and vault integrations.",
      cls: "setting-item-description",
    });

    this.searchShellEl = containerEl.createDiv({
      cls: "ss-settings-search-shell",
    });
    const searchHeader = this.searchShellEl.createDiv({
      cls: "ss-settings-search-shell__header",
    });
    const searchCopy = searchHeader.createDiv({
      cls: "ss-settings-search-shell__copy",
    });
    searchCopy.createDiv({
      cls: "ss-settings-search-shell__title",
      text: "Search settings",
    });
    searchCopy.createDiv({
      cls: "ss-settings-search-shell__description",
      text: "Jump straight to any setting, section, or integration.",
    });

    const searchInputRow = this.searchShellEl.createDiv({
      cls: "ss-settings-search-shell__input-row",
    });
    const searchIcon = searchInputRow.createSpan({
      cls: "ss-settings-search-shell__icon",
      attr: { "aria-hidden": "true" },
    });
    setIcon(searchIcon, "search");

    this.searchInputEl = searchInputRow.createEl("input", {
      cls: ["search-input", "ss-settings-search-input"],
      attr: {
        type: "search",
        placeholder: "Search settings, providers, studio, vault...",
        autocomplete: "off",
        spellcheck: "false",
        "aria-label": "Search SystemSculpt settings",
        role: "combobox",
        "aria-autocomplete": "list",
        "aria-haspopup": "listbox",
        "aria-controls": this.searchResultsListId,
        "aria-expanded": "false",
      },
    }) as HTMLInputElement;
    this.registerListener(this.searchInputEl, "input", () =>
      this.handleSearchInput(),
    );
    this.registerListener(
      this.searchInputEl,
      "keydown",
      (event: KeyboardEvent) => {
        this.handleSearchKeydown(event);
      },
    );

    this.clearSearchButtonEl = searchInputRow.createEl("button", {
      cls: "clickable-icon ss-settings-search-clear",
      attr: {
        type: "button",
        "aria-label": "Clear settings search",
        title: "Clear search",
      },
    }) as HTMLButtonElement;
    setIcon(this.clearSearchButtonEl, "x");
    this.clearSearchButtonEl.hidden = true;
    this.clearSearchButtonEl.disabled = true;
    this.registerListener(this.clearSearchButtonEl, "click", () =>
      this.clearSearch(true),
    );

    this.searchMetaEl = this.searchShellEl.createDiv({
      cls: "ss-settings-search-meta",
      attr: { "aria-live": "polite" },
    });

    const layout = containerEl.createDiv({ cls: "ss-settings-layout" });
    const tabBar = layout.createDiv({ cls: "ss-settings-tab-bar" });
    const contentContainer = layout.createDiv({ cls: "ss-settings-panels" });

    this.tabContainerEl = tabBar;
    this.contentContainerEl = contentContainer;

    const tabConfigsAll = buildSettingsTabConfigs(this);
    const visibleTabs = tabConfigsAll;
    const pendingFocusTabId =
      typeof (this.plugin as any).consumePendingSettingsFocusTab === "function"
        ? String((this.plugin as any).consumePendingSettingsFocusTab() || "").trim()
        : "";

    if (this.focusTabEventRef) {
      this.app.workspace.offref(this.focusTabEventRef);
      this.focusTabEventRef = null;
    }
    this.focusTabEventRef = this.app.workspace.on(
      "systemsculpt:settings-focus-tab",
      (requestedTab: string) => {
        if (!requestedTab) return;
        if (typeof (this.plugin as any).clearPendingSettingsFocusTab === "function") {
          (this.plugin as any).clearPendingSettingsFocusTab(requestedTab);
        }
        if (!this.tabContainerEl) return;
        const target = this.tabContainerEl.querySelector(
          `button[data-tab="${requestedTab}"]`,
        ) as HTMLElement | null;
        if (!target) return;
        this.clearSearch(false);
        this.activateTab(requestedTab);
      },
    );

    this.tabsDef = visibleTabs.map(({ id, label }) => ({ id, label }));
    const previousActiveTabId = this.activeTabId;
    const hasPendingFocusTab = pendingFocusTabId
      ? this.tabsDef.some((tab) => tab.id === pendingFocusTabId)
      : false;
    const hasPreviousActiveTab = this.tabsDef.some(
      (tab) => tab.id === previousActiveTabId,
    );
    this.activeTabId = hasPendingFocusTab
      ? pendingFocusTabId
      : hasPreviousActiveTab
        ? previousActiveTabId
        : (this.tabsDef[0]?.id ?? "account");

    for (const [index, cfg] of visibleTabs.entries()) {
      const button = tabBar.createEl("button", {
        cls: "ss-tab-button",
        text: cfg.label,
      });
      button.dataset.tab = cfg.id;
      if (cfg.id === this.activeTabId || (index === 0 && !this.activeTabId)) {
        button.addClass("mod-active");
      }
      this.registerListener(button, "click", () => this.activateTab(cfg.id));

      const panel = contentContainer.createDiv({
        cls: ["ss-tab-panel", "systemsculpt-tab-content"],
      });
      panel.dataset.tab = cfg.id;
      if (cfg.id === this.activeTabId) {
        panel.addClass("is-active");
        panel.toggle(true);
      } else {
        panel.removeClass("is-active");
        panel.toggle(false);
      }
    }

    for (const cfg of visibleTabs) {
      const sectionRoot = contentContainer.querySelector(
        `[data-tab="${cfg.id}"]`,
      ) as HTMLElement | null;
      if (!sectionRoot) continue;
      sectionRoot.empty();
      for (const render of cfg.sections) {
        render(sectionRoot);
      }
      if (cfg.anchor) {
        const anchor = sectionRoot.createDiv({
          attr: {
            "data-ss-search": "true",
            "data-ss-title": cfg.anchor.title,
            "data-ss-desc": cfg.anchor.desc,
          },
        });
        anchor.toggle(false);
      }
    }

    this.buildSettingsIndex();
    window.setTimeout(() => this.buildSettingsIndex(), 300);

    if (this.contentContainerEl) {
      if (this.contentMutationObserver) {
        this.contentMutationObserver.disconnect();
      }
      this.contentMutationObserver = new MutationObserver(() => {
        if (this.indexRebuildTimer) window.clearTimeout(this.indexRebuildTimer);
        this.indexRebuildTimer = window.setTimeout(
          () => this.buildSettingsIndex(),
          150,
        );
      });
      this.contentMutationObserver.observe(this.contentContainerEl, {
        childList: true,
        subtree: true,
      });
    }

    this.searchResultsContainerEl = layout.createDiv({
      cls: "ss-settings-search-results",
      attr: {
        id: this.searchResultsListId,
        role: "listbox",
        "aria-label": "Settings search results",
      },
    });
    this.searchResultsContainerEl.toggle(false);
    this.syncSearchChrome();
  }
  /**
   * Initialize version display and check for updates
   */
  private async initializeVersionDisplay() {
    if (!this.versionInfoContainer) return;

    // Clear previous content
    this.versionInfoContainer.empty();

    // Display current version while checking
    const currentVersion = this.plugin.manifest.version;
    this.versionInfoContainer.createSpan({
      cls: "ss-version-pill ss-version-pill--checking",
      text: `v${currentVersion} (checking...)`,
    });

    // Check for updates
    await this.checkForUpdates();
  }

  /**
   * Check for updates and update the UI
   */
  private async checkForUpdates(forceRefresh = false) {
    if (!this.versionInfoContainer) return;

    try {
      const versionInfo = await this.plugin
        .getVersionCheckerService()
        .checkVersion(forceRefresh);
      this.updateVersionDisplay(versionInfo);
    } catch (error) {
      const versionText = this.versionInfoContainer.querySelector(
        ".ss-version-pill",
      ) as HTMLElement | null;
      if (versionText) {
        versionText.setText(`v${this.plugin.manifest.version} (check failed)`);
        versionText.removeClass(
          "ss-version-pill--latest",
          "ss-version-pill--outdated",
          "ss-version-pill--checking",
        );
        versionText.addClass("ss-version-pill--error");
      }
    }
  }

  /**
   * Update the version display with the version info
   */
  private updateVersionDisplay(versionInfo: VersionInfo) {
    if (!this.versionInfoContainer) return;

    let versionText = this.versionInfoContainer.querySelector(
      ".ss-version-pill",
    ) as HTMLElement | null;
    if (!versionText) {
      versionText = this.versionInfoContainer.createSpan({
        cls: "ss-version-pill",
      });
    }

    versionText.removeClass(
      "ss-version-pill--latest",
      "ss-version-pill--outdated",
      "ss-version-pill--error",
      "ss-version-pill--checking",
    );

    if (versionInfo.isLatest) {
      versionText.setText(`v${versionInfo.currentVersion} (latest)`);
      versionText.addClass("ss-version-pill--latest");
      this.versionInfoContainer.querySelector(".ss-version-update")?.remove();
    } else {
      versionText.setText(
        `v${versionInfo.currentVersion} → v${versionInfo.latestVersion}`,
      );
      versionText.addClass("ss-version-pill--outdated");

      if (!this.versionInfoContainer.querySelector(".ss-version-update")) {
        const updateLink = this.versionInfoContainer.createEl("a", {
          cls: "ss-version-update",
          text: "Update",
          attr: {
            href: versionInfo.updateUrl,
            target: "_blank",
            rel: "noopener",
            "aria-label": "Open in Community Plugins",
          },
        });

        this.registerListener(updateLink, "click", (event) => {
          event.preventDefault();
          window.open(versionInfo.updateUrl, "_blank");
          new Notice(
            "Opening SystemSculpt AI in Community Plugins...\n\nIf nothing happens, please update manually via Settings → Community plugins",
            10000,
          );
        });
      }
    }
  }

  // Override hide method to clean up event listeners
  hide() {
    // Clean up resources from the currently active tab before closing
    const activeContent = this.containerEl.querySelector(
      ".systemsculpt-tab-content.is-active",
    ) as any;
    if (activeContent && activeContent.cleanup) {
      activeContent.cleanup();
      activeContent.cleanup = null;
    }

    this.removeAllListeners();
    if (this.contentMutationObserver) {
      this.contentMutationObserver.disconnect();
      this.contentMutationObserver = null;
    }
    if (this.focusTabEventRef) {
      this.app.workspace.offref(this.focusTabEventRef);
      this.focusTabEventRef = null;
    }
    super.hide();
  }

  /**
   * Build an index of all `.setting-item` elements across tabs for fast search
   */
  private activateTab(tabId: string) {
    if (!this.tabContainerEl || !this.contentContainerEl) {
      return;
    }

    const targetPanel = this.contentContainerEl.querySelector(
      `.systemsculpt-tab-content[data-tab="${tabId}"]`,
    ) as any;
    const activePanel = this.contentContainerEl.querySelector(
      ".systemsculpt-tab-content.is-active",
    ) as any;
    if (
      activePanel &&
      activePanel !== targetPanel &&
      typeof activePanel?.cleanup === "function"
    ) {
      try {
        activePanel.cleanup();
      } catch (_) {
        // ignore cleanup failures
      }
    }

    this.activeTabId = tabId;

    Array.from(
      this.tabContainerEl.querySelectorAll("button[data-tab]"),
    ).forEach((button) => {
      const el = button as HTMLElement;
      if (el.dataset.tab === tabId) {
        el.addClass("mod-active", "mod-cta");
      } else {
        el.removeClass("mod-active", "mod-cta");
      }
    });

    Array.from(
      this.contentContainerEl.querySelectorAll(".systemsculpt-tab-content"),
    ).forEach((panel) => {
      const el = panel as HTMLElement;
      if (el.dataset.tab === tabId) {
        el.addClass("is-active");
        el.toggle(true);
      } else {
        el.removeClass("is-active");
        el.toggle(false);
      }
    });
  }

  /**
   * Build an index of all `.setting-item` elements across tabs for fast search
   */
  private buildSettingsIndex() {
    this.allSettingsIndex = [];
    if (!this.contentContainerEl) {
      this.renderSearchMeta();
      return;
    }

    this.allSettingsIndex = buildSettingsIndexFromRoot(
      this.contentContainerEl,
      this.tabsDef,
    );
    if (this.searchState.query) {
      this.refreshSearchResults(this.searchState.query, false);
      return;
    }
    this.renderSearchMeta();
  }

  /**
   * Handle search input
   */
  private handleSearchInput() {
    if (!this.searchInputEl) return;
    const query = this.searchInputEl.value.trim();

    if (query.length === 0) {
      this.clearSearch(false);
      return;
    }

    this.refreshSearchResults(query, true);
  }

  /**
   * Handle keyboard navigation while the search field is focused.
   */
  private handleSearchKeydown(event: KeyboardEvent) {
    const hasActiveSearch = this.searchState.query.length > 0;

    if (event.key === "Escape") {
      if (!hasActiveSearch && !this.searchInputEl?.value) {
        return;
      }
      event.preventDefault();
      this.clearSearch(true);
      return;
    }

    if (!hasActiveSearch) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.moveSearchSelection(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.moveSearchSelection(-1);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      this.setSearchSelection(0, true);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      this.setSearchSelection(this.searchState.results.length - 1, true);
      return;
    }

    if (event.key === "Enter") {
      const match = this.searchState.results[this.searchState.selectedIndex];
      if (!match) {
        return;
      }
      event.preventDefault();
      this.navigateToSetting(match.tabId, match.element);
    }
  }

  /**
   * Recompute and render search results.
   */
  private refreshSearchResults(query: string, resetSelection: boolean) {
    if (
      !this.tabContainerEl ||
      !this.contentContainerEl ||
      !this.searchResultsContainerEl
    ) {
      return;
    }

    const resultSet = searchSettingsIndex(this.allSettingsIndex, query);
    const nextSelectedIndex =
      resultSet.results.length === 0
        ? -1
        : resetSelection
          ? 0
          : Math.min(
              Math.max(this.searchState.selectedIndex, 0),
              resultSet.results.length - 1,
            );

    this.searchState = {
      query,
      groups: resultSet.groups,
      results: resultSet.results,
      selectedIndex: nextSelectedIndex,
    };

    this.tabContainerEl.toggle(false);
    Array.from(
      this.contentContainerEl.querySelectorAll(".systemsculpt-tab-content"),
    ).forEach((panel) => (panel as HTMLElement).toggle(false));

    this.renderSearchMeta();
    this.renderSearchResults();
    this.syncSearchChrome();
  }

  /**
   * Exit search mode: show tabs and active content, hide results
   */
  private exitSearchMode() {
    if (
      !this.tabContainerEl ||
      !this.contentContainerEl ||
      !this.searchResultsContainerEl
    ) {
      return;
    }

    this.searchResultsContainerEl.empty();
    this.searchResultsContainerEl.toggle(false);
    this.tabContainerEl.toggle(true);
    this.activateTab(this.activeTabId);
    this.renderSearchMeta();
    this.syncSearchChrome();
  }

  /**
   * Clear the search shell and restore the normal tab view.
   */
  private clearSearch(restoreFocus: boolean) {
    if (this.searchInputEl) {
      this.searchInputEl.value = "";
    }
    this.searchState = {
      query: "",
      groups: [],
      results: [],
      selectedIndex: -1,
    };
    this.exitSearchMode();
    if (restoreFocus) {
      this.searchInputEl?.focus();
    }
  }

  private renderSearchMeta() {
    if (!this.searchMetaEl) {
      return;
    }

    this.searchMetaEl.empty();
    const summary = this.searchMetaEl.createDiv({
      cls: "ss-settings-search-meta__summary",
    });
    const actions = this.searchMetaEl.createDiv({
      cls: "ss-settings-search-meta__actions",
    });

    if (this.searchState.query) {
      if (this.searchState.results.length === 0) {
        summary.createSpan({
          cls: "ss-settings-search-meta__count",
          text: "No matching settings",
        });
      } else {
        summary.createSpan({
          cls: "ss-settings-search-meta__count",
          text: `${this.searchState.results.length} ${
            this.searchState.results.length === 1 ? "result" : "results"
          }`,
        });
        summary.createSpan({
          cls: "ss-settings-search-meta__subtle",
          text: `across ${this.searchState.groups.length} ${
            this.searchState.groups.length === 1 ? "tab" : "tabs"
          }`,
        });
      }

      summary.createSpan({
        cls: "ss-settings-search-meta__query",
        text: `“${this.searchState.query}”`,
      });

      this.createKeyboardHint(actions, ["↑", "↓"], "move");
      if (this.searchState.results.length > 0) {
        this.createKeyboardHint(actions, ["Enter"], "open");
      }
      this.createKeyboardHint(actions, ["Esc"], "clear");
      return;
    }

    const tabCount = new Set(
      this.allSettingsIndex.map((entry) => entry.tabId).filter(Boolean),
    ).size;
    if (this.allSettingsIndex.length > 0) {
      summary.createSpan({
        cls: "ss-settings-search-meta__count",
        text: `${this.allSettingsIndex.length} searchable items`,
      });
      summary.createSpan({
        cls: "ss-settings-search-meta__subtle",
        text: `across ${tabCount || this.tabsDef.length} ${
          (tabCount || this.tabsDef.length) === 1 ? "tab" : "tabs"
        }`,
      });
    } else {
      summary.createSpan({
        cls: "ss-settings-search-meta__count",
        text: "Search across every tab",
      });
    }

    actions.createSpan({
      cls: "ss-settings-search-meta__idle-copy",
      text: "Search titles, descriptions, and section anchors.",
    });
  }

  private createKeyboardHint(
    parent: HTMLElement,
    keys: string[],
    label: string,
  ) {
    const hint = parent.createSpan({ cls: "ss-settings-search-key-hint" });
    for (const key of keys) {
      hint.createEl("kbd", { text: key });
    }
    hint.createSpan({ text: label });
  }

  private syncSearchChrome() {
    const searchActive = this.searchState.query.length > 0;
    this.searchShellEl?.classList.toggle("is-search-active", searchActive);

    if (this.clearSearchButtonEl) {
      this.clearSearchButtonEl.hidden = !searchActive;
      this.clearSearchButtonEl.disabled = !searchActive;
    }

    if (this.searchInputEl) {
      this.searchInputEl.setAttribute(
        "aria-expanded",
        searchActive ? "true" : "false",
      );
      if (searchActive && this.searchState.selectedIndex >= 0) {
        this.searchInputEl.setAttribute(
          "aria-activedescendant",
          this.getSearchResultId(this.searchState.selectedIndex),
        );
      } else {
        this.searchInputEl.removeAttribute("aria-activedescendant");
      }
    }
  }

  /**
   * Render the grouped search results list.
   */
  private renderSearchResults() {
    if (!this.searchResultsContainerEl) {
      return;
    }

    this.searchResultsContainerEl.empty();
    this.searchResultsContainerEl.toggle(true);

    if (this.searchState.results.length === 0) {
      const emptyState = this.searchResultsContainerEl.createDiv({
        cls: "ss-search-empty-state",
      });
      const emptyIcon = emptyState.createDiv({
        cls: "ss-search-empty-state__icon",
        attr: { "aria-hidden": "true" },
      });
      setIcon(emptyIcon, "search");
      emptyState.createDiv({
        cls: "ss-search-empty-state__title",
        text: `No settings found for “${this.searchState.query}”`,
      });
      emptyState.createDiv({
        cls: "ss-search-empty-state__description",
        text: "Try a broader phrase, a tab name, or a feature like studio, provider, or embeddings.",
      });
      return;
    }

    let flatIndex = 0;
    for (const group of this.searchState.groups) {
      const groupEl = this.searchResultsContainerEl.createDiv({
        cls: "ss-search-group",
      });
      const groupHeader = groupEl.createDiv({ cls: "ss-search-group__header" });
      groupHeader.createSpan({
        cls: "ss-search-group__title",
        text: group.tabLabel,
      });
      groupHeader.createSpan({
        cls: "ss-search-group__count",
        text: `${group.results.length}`,
      });

      const groupResults = groupEl.createDiv({
        cls: "ss-search-group__results",
      });
      for (const match of group.results) {
        const rowIndex = flatIndex;
        const row = groupResults.createEl("button", {
          cls: "ss-search-result",
          attr: {
            id: this.getSearchResultId(rowIndex),
            type: "button",
            role: "option",
            "aria-selected":
              rowIndex === this.searchState.selectedIndex ? "true" : "false",
          },
        });
        row.classList.toggle(
          "is-selected",
          rowIndex === this.searchState.selectedIndex,
        );

        const copy = row.createDiv({ cls: "ss-search-result__copy" });
        const titleRow = copy.createDiv({ cls: "ss-search-result__title-row" });
        const titleEl = titleRow.createDiv({ cls: "ss-search-result__title" });
        this.renderHighlightedText(
          titleEl,
          match.title || match.description || "(Untitled setting)",
          this.searchState.query,
        );
        if (match.kind === "anchor") {
          titleRow.createSpan({
            cls: "ss-search-result__badge",
            text: "Section",
          });
        }

        const descriptionEl = copy.createDiv({
          cls: "ss-search-result__description",
        });
        const descriptionText =
          match.description ||
          (match.kind === "anchor"
            ? `Jump to this section in ${group.tabLabel}.`
            : `Open this setting in ${group.tabLabel}.`);
        this.renderHighlightedText(
          descriptionEl,
          descriptionText,
          this.searchState.query,
        );

        const meta = row.createDiv({ cls: "ss-search-result__meta" });
        const openHint = meta.createDiv({ cls: "ss-search-result__open" });
        const openIcon = openHint.createSpan({
          cls: "ss-search-result__open-icon",
          attr: { "aria-hidden": "true" },
        });
        setIcon(openIcon, "arrow-right");
        openHint.createSpan({ text: "Open" });

        row.addEventListener("mouseenter", () =>
          this.setSearchSelection(rowIndex, false),
        );
        row.addEventListener("click", () =>
          this.navigateToSetting(match.tabId, match.element),
        );
        flatIndex += 1;
      }
    }

    this.syncRenderedSearchSelection(false);
  }

  private renderHighlightedText(
    parent: HTMLElement,
    text: string,
    query: string,
  ) {
    parent.empty();
    const parts = buildSettingsSearchHighlightParts(text, query);
    for (const part of parts) {
      if (!part.matched) {
        parent.appendText(part.text);
        continue;
      }

      parent.createEl("mark", {
        cls: "ss-search-mark",
        text: part.text,
      });
    }
  }

  private moveSearchSelection(delta: number) {
    if (this.searchState.results.length === 0) {
      return;
    }

    const currentIndex =
      this.searchState.selectedIndex < 0 ? 0 : this.searchState.selectedIndex;
    const nextIndex = Math.max(
      0,
      Math.min(currentIndex + delta, this.searchState.results.length - 1),
    );
    this.setSearchSelection(nextIndex, true);
  }

  private setSearchSelection(index: number, scrollIntoView: boolean) {
    if (this.searchState.results.length === 0) {
      this.searchState.selectedIndex = -1;
      this.syncRenderedSearchSelection(false);
      return;
    }

    const nextIndex = Math.max(
      0,
      Math.min(index, this.searchState.results.length - 1),
    );
    if (nextIndex === this.searchState.selectedIndex) {
      if (scrollIntoView) {
        this.syncRenderedSearchSelection(true);
      }
      return;
    }

    this.searchState.selectedIndex = nextIndex;
    this.syncRenderedSearchSelection(scrollIntoView);
  }

  private syncRenderedSearchSelection(scrollIntoView: boolean) {
    if (!this.searchResultsContainerEl) {
      return;
    }

    const rows = Array.from(
      this.searchResultsContainerEl.querySelectorAll<HTMLElement>(
        ".ss-search-result",
      ),
    );
    rows.forEach((row, index) => {
      const selected = index === this.searchState.selectedIndex;
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected && scrollIntoView) {
        row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });

    this.syncSearchChrome();
  }

  private getSearchResultId(index: number): string {
    return `${this.searchResultsListId}-${index}`;
  }

  /**
   * Activate the tab and scroll to the target setting element
   */
  private navigateToSetting(tabId: string, element: HTMLElement) {
    if (!this.tabContainerEl || !this.contentContainerEl) return;

    // Exit search mode and clear input
    this.clearSearch(false);

    this.activateTab(tabId);

    // Scroll to element and highlight
    setTimeout(() => {
      try {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        element.addClass("ss-search-highlight");
        setTimeout(() => element.removeClass("ss-search-highlight"), 1200);
      } catch (e) {
        // If element no longer exists (mode switch), just ensure tab is visible
      }
    }, 50);
  }
}
