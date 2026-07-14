import {
  App,
  PluginSettingTab,
  Setting,
  Notice,
  setIcon,
  Platform,
  EventRef,
} from "obsidian";
import { showPrompt } from "../core/ui/modals/PromptModal";
import {
  applyPluginSurface,
  createUiAction,
  createUiSearch,
  createUiState,
  createUiTabs,
  getSurfaceOwnerWindow,
  SurfaceCombobox,
  type UiSearchHandle,
  type UiTabBinding,
  type UiTabsHandle,
} from "../core/ui/surface";
import SystemSculptPlugin from "../main";
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
};

type SystemSculptSettingDefinition = {
  id: string;
  name: string;
  description?: string;
};

export class SystemSculptSettingTab extends PluginSettingTab {
  plugin: SystemSculptPlugin;
  private listeners: {
    element: HTMLElement;
    type: string;
    listener: EventListener;
  }[] = [];
  private renderCleanups = new Set<() => void>();
  private tabContainerEl: HTMLElement | null = null;
  private contentContainerEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private searchShellEl: HTMLElement | null = null;
  private searchMetaEl: HTMLElement | null = null;
  private clearSearchButtonEl: HTMLButtonElement | null = null;
  private searchHandle: UiSearchHandle | null = null;
  private searchResultsContainerEl: HTMLElement | null = null;
  private searchCombobox: SurfaceCombobox<SettingsSearchMatch> | null = null;
  private searchResultGroupEls = new Map<string, HTMLElement>();
  private searchResultKeyByElement = new WeakMap<HTMLElement, string>();
  private nextSearchResultKey = 0;
  private allSettingsIndex: SettingsIndexEntry[] = [];
  private tabsDef: { id: string; label: string }[] = [];
  private tabsHandle: UiTabsHandle<string> | null = null;
  private contentMutationObserver: MutationObserver | null = null;
  private indexRebuildTimer: number | null = null;
  private indexRebuildTimerWindow: Window | null = null;
  private activeTabId: string = "account";
  private focusTabEventRef: EventRef | null = null;
  private searchState: SettingsSearchViewState = {
    query: "",
    groups: [],
    results: [],
  };
  private readonly searchResultsListId = "systemsculpt-settings-search-results";

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Registers work that must stop when settings rerender, hide, or unload. */
  registerRenderCleanup(cleanup: () => void): () => void {
    this.renderCleanups.add(cleanup);
    return () => this.renderCleanups.delete(cleanup);
  }

  getSettingDefinitions(): SystemSculptSettingDefinition[] {
    return buildSettingsTabConfigs(this).map((config) => ({
      id: config.id,
      name: config.anchor?.title || config.label,
      description: config.anchor?.desc || `${config.label} settings`,
    }));
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
    const ownerWindow = getSurfaceOwnerWindow(this.containerEl);

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
    }
    if (os) {
      environmentInfo.push(`- OS: ${os}`);
    }

    // Device type
    let deviceType = "";
    if (Platform.isDesktopApp) {
      deviceType = "Desktop";
    }
    if (deviceType) {
      environmentInfo.push(`- Device type: ${deviceType}`);
    }

    // Theme
    const isDarkTheme = ownerWindow.document.body.classList.contains("theme-dark");
    environmentInfo.push(`- Theme: ${isDarkTheme ? "Dark" : "Light"}`);

    // Language/Locale
    if (ownerWindow.navigator.language) {
      environmentInfo.push(`- Language: ${ownerWindow.navigator.language}`);
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
    const enabledFeatures: string[] = ["Vault tools"];
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
        const confirm = await showPrompt(this.app, RESTORE_DEFAULTS_COPY.label, {
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

  private invalidateRenderCleanups(): void {
    const cleanups = [...this.renderCleanups];
    this.renderCleanups.clear();
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Cleanup must never prevent the settings host from closing.
      }
    }
  }

  private clearSettingsIndexRebuild(): void {
    if (this.indexRebuildTimer !== null) {
      this.indexRebuildTimerWindow?.clearTimeout(this.indexRebuildTimer);
      this.indexRebuildTimer = null;
      this.indexRebuildTimerWindow = null;
    }
  }

  private scheduleSettingsIndexRebuild(ownerWindow: Window, delayMs: number): void {
    this.clearSettingsIndexRebuild();
    this.indexRebuildTimerWindow = ownerWindow;
    this.indexRebuildTimer = ownerWindow.setTimeout(() => {
      this.indexRebuildTimer = null;
      this.indexRebuildTimerWindow = null;
      this.buildSettingsIndex();
    }, delayMs);
  }

  async display(): Promise<void> {
    this.invalidateRenderCleanups();
    this.clearSettingsIndexRebuild();
    this.removeAllListeners();
    this.tabsHandle?.destroy();
    this.tabsHandle = null;
    this.searchCombobox?.destroy();
    this.searchCombobox = null;
    this.searchHandle?.destroy();
    this.searchHandle = null;
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
    };

    const surfaceRoot = containerEl.createDiv({ cls: "ss-settings-surface" });
    applyPluginSurface(surfaceRoot, "view");
    const surfaceWindow = surfaceRoot.ownerDocument.defaultView ?? window;

    const titleRow = surfaceRoot.createDiv({ cls: "ss-settings-title-row" });
    const titleGroup = titleRow.createDiv({ cls: "ss-settings-title-group" });
    const titleMeta = titleGroup.createDiv({ cls: "ss-settings-title-meta" });
    titleMeta.createDiv({
      cls: "ss-settings-title-version",
      text: `v${this.plugin.manifest.version}`,
    });

    surfaceRoot.createEl("p", {
      text: "Account, workspace, and vault preferences.",
      cls: "setting-item-description",
    });

    this.searchShellEl = surfaceRoot.createDiv({
      cls: "ss-settings-search-shell",
    });
    this.searchHandle = createUiSearch(this.searchShellEl, {
      label: "Search SystemSculpt settings",
      placeholder: "Search settings",
      onQuery: () => this.handleSearchInput(),
    });
    this.searchInputEl = this.searchHandle.input;
    this.searchInputEl.autocomplete = "off";
    this.searchInputEl.spellcheck = false;
    this.clearSearchButtonEl = this.searchHandle.root.querySelector(
      ".ss-search-field__clear",
    ) as HTMLButtonElement | null;

    this.searchMetaEl = this.searchShellEl.createDiv({
      cls: "ss-settings-search-meta",
      attr: { "aria-live": "polite" },
    });

    const layout = surfaceRoot.createDiv({ cls: "ss-settings-layout" });
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

    const tabBindings: UiTabBinding<string>[] = [];
    for (const cfg of visibleTabs) {
      const button = createUiAction(tabBar, {
        label: cfg.label,
        size: "small",
      });
      button.addClass("ss-tab-button");
      button.dataset.tab = cfg.id;

      const panel = contentContainer.createDiv({
        cls: ["ss-tab-panel", "systemsculpt-tab-content"],
      });
      panel.dataset.tab = cfg.id;
      tabBindings.push({ id: cfg.id, button, panel });
    }

    this.tabsHandle = createUiTabs(tabBar, tabBindings, {
      activeId: this.activeTabId,
      onChange: (tabId, previousTabId) => {
        this.handleTabChange(tabId, previousTabId);
      },
    });

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
        anchor.toggleAttribute("hidden", true);
      }
    }

    this.buildSettingsIndex();
    this.scheduleSettingsIndexRebuild(surfaceWindow, 300);

    if (this.contentContainerEl) {
      if (this.contentMutationObserver) {
        this.contentMutationObserver.disconnect();
      }
      this.contentMutationObserver = new MutationObserver(() => {
        this.scheduleSettingsIndexRebuild(surfaceWindow, 150);
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
      },
    });
    this.searchResultsContainerEl.toggleAttribute("hidden", true);
    this.initializeSearchCombobox();
    this.syncSearchChrome();
  }
  // Override hide method to clean up event listeners
  hide() {
    this.invalidateRenderCleanups();
    this.clearSettingsIndexRebuild();
    // Clean up resources from the currently active tab before closing
    const activeContent = this.containerEl.querySelector(
      ".systemsculpt-tab-content.is-active",
    ) as any;
    if (activeContent && activeContent.cleanup) {
      activeContent.cleanup();
      activeContent.cleanup = null;
    }

    this.removeAllListeners();
    this.tabsHandle?.destroy();
    this.tabsHandle = null;
    this.searchCombobox?.destroy();
    this.searchCombobox = null;
    this.searchHandle?.destroy();
    this.searchHandle = null;
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
    this.tabsHandle?.activate(tabId);
  }

  private handleTabChange(tabId: string, previousTabId: string): void {
    if (!this.contentContainerEl) return;
    const activePanel = this.contentContainerEl.querySelector(
      `.systemsculpt-tab-content[data-tab="${previousTabId}"]`,
    ) as any;
    if (activePanel && typeof activePanel?.cleanup === "function") {
      try {
        activePanel.cleanup();
      } catch (_) {
        // ignore cleanup failures
      }
    }

    this.activeTabId = tabId;
  }

  private initializeSearchCombobox(): void {
    if (!this.searchInputEl || !this.searchResultsContainerEl) return;
    this.searchCombobox?.destroy();
    this.searchCombobox = new SurfaceCombobox<SettingsSearchMatch>({
      input: this.searchInputEl,
      listbox: this.searchResultsContainerEl,
      listboxId: this.searchResultsListId,
      listboxLabel: "Settings search results",
      initiallyOpen: false,
      activeMode: "first",
      navigation: "clamp",
      selectionFollowsActive: true,
      activeClass: "is-selected",
      optionActivationEvent: "mouseenter",
      scrollBehavior: "smooth",
      bindInputEvents: false,
      getItemKey: (match) => this.getSearchResultKey(match),
      filterItems: (matches) => matches,
      renderOption: ({ item }) => this.renderSearchResult(item),
      renderEmpty: ({ listbox }) => {
        createUiState(listbox, {
          kind: "empty",
          icon: "search",
          title: "No settings found",
          detail: "Try another search.",
        });
      },
      onResultsChange: () => this.searchResultGroupEls.clear(),
      onCommit: ({ item }) => this.navigateToSetting(item.tabId, item.element),
      onEscape: () => this.clearSearch(true),
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
    const orderedResults = resultSet.groups.flatMap((group) => group.results);

    this.searchState = {
      query,
      groups: resultSet.groups,
      results: orderedResults,
    };

    this.tabContainerEl.toggleAttribute("hidden", true);
    Array.from(
      this.contentContainerEl.querySelectorAll(".systemsculpt-tab-content"),
    ).forEach((panel) => (panel as HTMLElement).toggleAttribute("hidden", true));

    this.renderSearchMeta();
    this.searchResultsContainerEl.toggleAttribute("hidden", false);
    this.searchCombobox?.setQuery(query, {
      writeInput: false,
      render: false,
    });
    this.searchCombobox?.setOpen(true);
    this.searchCombobox?.setItems(orderedResults, {
      preserveActive: !resetSelection,
    });
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

    this.searchCombobox?.showState(() => {}, { open: false });
    this.searchResultsContainerEl.toggleAttribute("hidden", true);
    this.tabContainerEl.toggleAttribute("hidden", false);
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
        text: `${this.allSettingsIndex.length} settings in ${
          tabCount || this.tabsDef.length
        } ${(tabCount || this.tabsDef.length) === 1 ? "tab" : "tabs"}`,
      });
    } else {
      summary.createSpan({
        cls: "ss-settings-search-meta__count",
        text: "Search all settings",
      });
    }
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

  }

  private renderSearchResult(match: SettingsSearchMatch): HTMLElement {
    const group = this.searchState.groups.find(
      (candidate) => candidate.tabId === match.tabId,
    );
    const groupResults = this.getOrCreateSearchResultGroup(
      match.tabId,
      group?.tabLabel || match.tabLabel,
      group?.results.length ?? 1,
    );
    const row = groupResults.createEl("button", {
      cls: "ss-search-result",
      attr: { type: "button" },
    });

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
    const descriptionText = match.description ||
      (match.kind === "anchor"
        ? `Jump to this section in ${match.tabLabel}.`
        : `Open this setting in ${match.tabLabel}.`);
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
    return row;
  }

  private getOrCreateSearchResultGroup(
    tabId: string,
    tabLabel: string,
    count: number,
  ): HTMLElement {
    const existing = this.searchResultGroupEls.get(tabId);
    if (existing) return existing;
    const groupEl = this.searchResultsContainerEl!.createDiv({
      cls: "ss-search-group",
    });
    const groupHeader = groupEl.createDiv({ cls: "ss-search-group__header" });
    groupHeader.createSpan({
      cls: "ss-search-group__title",
      text: tabLabel,
    });
    groupHeader.createSpan({
      cls: "ss-search-group__count",
      text: `${count}`,
    });
    const groupResults = groupEl.createDiv({
      cls: "ss-search-group__results",
    });
    this.searchResultGroupEls.set(tabId, groupResults);
    return groupResults;
  }

  private getSearchResultKey(match: SettingsSearchMatch): string {
    const existing = this.searchResultKeyByElement.get(match.element);
    if (existing) return existing;
    const key = `setting-${++this.nextSearchResultKey}`;
    this.searchResultKeyByElement.set(match.element, key);
    return key;
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

  /**
   * Activate the tab and scroll to the target setting element
   */
  private navigateToSetting(tabId: string, element: HTMLElement) {
    if (!this.tabContainerEl || !this.contentContainerEl) return;

    // Exit search mode and clear input
    this.clearSearch(false);

    this.activateTab(tabId);

    // Scroll to element and highlight
    const ownerWindow = this.containerEl.ownerDocument.defaultView ?? window;
    ownerWindow.setTimeout(() => {
      try {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        element.addClass("ss-search-highlight");
        ownerWindow.setTimeout(() => element.removeClass("ss-search-highlight"), 1200);
      } catch (e) {
        // If element no longer exists (mode switch), just ensure tab is visible
      }
    }, 50);
  }
}
