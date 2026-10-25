import {
  App,
  PluginSettingTab,
  Notice,
  setIcon,
  EventRef,
  apiVersion,
} from "obsidian";
import { showPrompt } from "../core/ui/modals/PromptModal";
import {
  formatDevelopmentBuildLabel,
  getDevelopmentBuildIdentity,
} from "../core/plugin/DevelopmentBuildIdentity";
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
import type { ConnectOutcome } from "../services/AccountConnectService";
import { getHostDeviceType, getHostOperatingSystem } from "../platform/hostCapabilities";
import {
  buildSettingsIndexFromRoot,
  buildSettingsSearchHighlightParts,
  searchSettingsIndex,
  type SettingsIndexEntry,
  type SettingsSearchGroup,
  type SettingsSearchMatch,
} from "./SettingsSearchIndex";
import { buildSettingsTabConfigs, type SettingsTabConfig } from "./SettingsTabRegistry";
import { createCatalogSetting, getSettingsCatalog } from "./SettingsCatalog";
import {
  decorateRestoreDefaultsButton,
  RESTORE_DEFAULTS_COPY,
} from "./uiHelpers";

type SettingsSearchViewState = {
  query: string;
  groups: SettingsSearchGroup[];
  results: SettingsSearchMatch[];
};

export class SystemSculptSettingTab extends PluginSettingTab {
  plugin: SystemSculptPlugin;
  /** The latest sign-in result, shown in Account until settings close or a new sign-in starts. */
  accountConnectOutcome: ConnectOutcome | null = null;
  private renderCleanups = new Map<() => void, HTMLElement | null>();
  private renderingSection: HTMLElement | null = null;
  private sectionRenderers = new Map<HTMLElement, () => void>();
  private renderedTabs = new Set<string>();
  private tabConfigs: SettingsTabConfig[] = [];
  private searchIndexDirty = true;
  private phoneCapturesLinked = false;
  private tabContainerEl: HTMLElement | null = null;
  private contentContainerEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private searchShellEl: HTMLElement | null = null;
  private searchMetaEl: HTMLElement | null = null;
  private searchHandle: UiSearchHandle | null = null;
  private searchResultsContainerEl: HTMLElement | null = null;
  private searchCombobox: SurfaceCombobox<SettingsSearchMatch> | null = null;
  private searchResultGroupEls = new Map<string, HTMLElement>();
  private searchResultKeyByElement = new WeakMap<HTMLElement, string>();
  private nextSearchResultKey = 0;
  private allSettingsIndex: SettingsIndexEntry[] = [];
  private tabsDef: { id: string; label: string }[] = [];
  private tabsHandle: UiTabsHandle<string> | null = null;
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
    this.renderCleanups.set(cleanup, this.renderingSection);
    return () => this.renderCleanups.delete(cleanup);
  }

  registerListener<K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ) {
    element.addEventListener(type, listener);
    this.registerRenderCleanup(() => element.removeEventListener(type, listener));
  }

  private generateFeedbackUrl(): string {
    const environmentInfo: string[] = [];
    const ownerWindow = getSurfaceOwnerWindow(this.containerEl);

    // Plugin version - always available
    environmentInfo.push(
      `- SystemSculpt AI version: ${this.plugin.manifest.version}`,
    );

    // Obsidian version
    const obsidianVersion = apiVersion;
    if (obsidianVersion) {
      environmentInfo.push(`- Obsidian version: ${obsidianVersion}`);
    }

    // OS
    const os = getHostOperatingSystem();
    if (os !== "Unknown") {
      environmentInfo.push(`- OS: ${os}`);
    }

    // Device type
    const deviceType = getHostDeviceType();
    if (deviceType !== "Unknown") {
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
    const actionsSetting = createCatalogSetting(containerEl, "advanced.quick-actions");
    actionsSetting.settingEl.addClass("ss-settings-quick-actions");

    actionsSetting.addButton((button) => {
      decorateRestoreDefaultsButton(button.buttonEl);
      button.onClick(async () => {
        const confirm = await showPrompt(this.app, RESTORE_DEFAULTS_COPY.label, {
          description:
            "Restore the recommended chat text size, audio output, Similar notes, output folders, and debug setting? These settings will replace your current choices. Other settings will stay unchanged.",
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
            audioProcessorOutputPreset: "detailed",
            embeddingsEnabled: false,
            chatsDirectory: "SystemSculpt/Chats",
            extractionsDirectory: "SystemSculpt/Extractions",
            debugMode: false,
          });
          this.refreshSettings();
        } catch {
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
        href: "https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues/new",
        target: "_blank",
        rel: "noopener",
        "aria-label": "Share feedback, report bugs, or suggest improvements",
      },
    });
    const prepareFeedback = () => { feedbackLink.href = this.generateFeedbackUrl(); };
    this.registerListener(feedbackLink, "click", prepareFeedback);
    this.registerListener(feedbackLink, "auxclick", prepareFeedback);
    setIcon(
      feedbackLink.createSpan({ cls: "ss-settings-link-icon" }),
      "external-link",
    );
  }

  private invalidateRenderCleanups(section?: HTMLElement): void {
    for (const [cleanup, owner] of [...this.renderCleanups]) {
      if (section && owner !== section) continue;
      this.renderCleanups.delete(cleanup);
      try {
        cleanup();
      } catch {
        // Cleanup must never prevent the settings host from closing.
      }
    }
  }

  /** Refresh one mounted section; hidden sections are invalidated, never rendered. */
  refreshSection(element: HTMLElement): void {
    const section = element.closest<HTMLElement>("[data-settings-section]");
    if (!section) return;
    const render = this.sectionRenderers.get(section);
    if (!render) return;
    this.invalidateRenderCleanups(section);
    section.empty();
    this.searchIndexDirty = true;
    const panel = section.closest<HTMLElement>(".systemsculpt-tab-content");
    if (panel?.hidden) {
      section.dataset.settingsDirty = "true";
      return;
    }
    delete section.dataset.settingsDirty;
    const previous = this.renderingSection;
    this.renderingSection = section;
    try {
      render();
    } finally {
      this.renderingSection = previous;
    }
  }

  /** A restore replaces settings across sections, but keeps the shell and selection. */
  refreshSettings(): void {
    for (const section of this.sectionRenderers.keys()) this.refreshSection(section);
  }

  /** In-place row changes are indexed on the next search input, not by observing DOM. */
  invalidateSearchIndex(): void {
    this.searchIndexDirty = true;
  }

  private syncPhoneCaptureVisibility(): void {
    const linked = this.plugin.settings.phoneCapturesLinked === true;
    if (linked === this.phoneCapturesLinked) return;
    this.phoneCapturesLinked = linked;
    this.invalidateSearchIndex();
    const section = this.contentContainerEl?.querySelector<HTMLElement>('[data-settings-section="workspace-1"]');
    if (section) this.refreshSection(section);
    const anchor = this.contentContainerEl?.querySelector<HTMLElement>('[data-tab="workspace"] [data-ss-search]');
    const config = this.tabConfigs.find((tab) => tab.id === "workspace");
    if (anchor && config?.anchor) anchor.dataset.ssTitle = config.anchor.title;
  }

  private renderTab(tabId: string): void {
    this.syncPhoneCaptureVisibility();
    const panel = this.contentContainerEl?.querySelector<HTMLElement>(`[data-tab="${tabId}"]`);
    const config = this.tabConfigs.find((tab) => tab.id === tabId);
    if (!panel || !config) return;
    if (!this.renderedTabs.has(tabId)) {
      this.renderedTabs.add(tabId);
      for (const [index, render] of config.sections.entries()) {
        const section = panel.createDiv({ attr: { "data-settings-section": `${tabId}-${index}` } });
        this.sectionRenderers.set(section, () => render(section));
        this.refreshSection(section);
      }
      if (config.anchor) {
        panel.createDiv({ attr: {
          "data-ss-search": "true",
          "data-ss-title": config.anchor.title,
          "data-ss-desc": config.anchor.desc,
          hidden: "",
        } });
      }
    } else {
      for (const section of panel.querySelectorAll<HTMLElement>("[data-settings-dirty]")) {
        this.refreshSection(section);
      }
    }
  }

  display(): void {
    this.disposeRender();
    const { containerEl } = this;
    containerEl.empty();

    this.tabContainerEl = null;
    this.contentContainerEl = null;
    this.searchInputEl = null;
    this.searchShellEl = null;
    this.searchMetaEl = null;
    this.searchResultsContainerEl = null;
    this.searchState = {
      query: "",
      groups: [],
      results: [],
    };

    const surfaceRoot = containerEl.createDiv({ cls: "ss-settings-surface" });
    applyPluginSurface(surfaceRoot, "view");

    const titleRow = surfaceRoot.createDiv({ cls: "ss-settings-title-row" });
    const titleGroup = titleRow.createDiv({ cls: "ss-settings-title-group" });
    const titleMeta = titleGroup.createDiv({ cls: "ss-settings-title-meta" });
    const developmentBuild = getDevelopmentBuildIdentity(this.plugin.manifest);
    titleMeta.createDiv({
      cls: "ss-settings-title-version",
      text: [
        `v${this.plugin.manifest.version}`,
        formatDevelopmentBuildLabel(this.plugin.manifest),
      ].filter(Boolean).join(" · "),
      ...(developmentBuild ? {
        attr: {
          title: `Synced ${developmentBuild.syncedAt} from ${developmentBuild.sourcePath} (${developmentBuild.branch})`,
        },
      } : {}),
    });

    surfaceRoot.createEl("p", {
      text: "Account, workspace, and vault preferences.",
      cls: "setting-item-description",
    });

    this.searchShellEl = surfaceRoot.createDiv({
      cls: "ss-settings-search-shell",
    });
    this.searchHandle = createUiSearch(this.searchShellEl, {
      testId: "settings.search",
      label: "Search SystemSculpt settings",
      placeholder: "Search settings",
      onQuery: () => this.handleSearchInput(),
    });
    this.searchInputEl = this.searchHandle.input;
    this.searchInputEl.autocomplete = "off";
    this.searchInputEl.spellcheck = false;

    this.searchMetaEl = this.searchShellEl.createDiv({
      cls: "ss-settings-search-meta",
      attr: { "aria-live": "polite" },
    });
    const layout = surfaceRoot.createDiv({ cls: "ss-settings-layout" });
    const tabBar = layout.createDiv({ cls: "ss-settings-tab-bar" });
    const contentContainer = layout.createDiv({ cls: "ss-settings-panels" });

    this.tabContainerEl = tabBar;
    this.contentContainerEl = contentContainer;

    this.tabConfigs = buildSettingsTabConfigs(this);
    const visibleTabs = this.tabConfigs;
    const pendingFocusTabId = String(
      this.plugin.consumePendingSettingsFocusTab() || "",
    ).trim();

    if (this.focusTabEventRef) {
      this.app.workspace.offref(this.focusTabEventRef);
      this.focusTabEventRef = null;
    }
    this.focusTabEventRef = this.app.workspace.on(
      "systemsculpt:settings-focus-tab",
      (requestedTab: string) => {
        if (!requestedTab) return;
        this.plugin.clearPendingSettingsFocusTab(requestedTab);
        if (!this.tabContainerEl) return;
        const target = this.tabContainerEl.querySelector<HTMLButtonElement>(
          `button[data-tab="${requestedTab}"]`,
        );
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
        testId: `settings.tab.${cfg.id}`,
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
      onChange: (tabId) => {
        this.handleTabChange(tabId);
      },
    });

    this.renderTab(this.activeTabId);

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
  hide(): void {
    this.disposeRender();
    this.backgroundUnfinishedSignIn();
    this.accountConnectOutcome = null;
    super.hide();
  }

  /**
   * Shows a sign-in result in the Account tab when it is the open settings
   * tab; false otherwise, so the result is shown somewhere visible instead.
   */
  showAccountConnectOutcome(outcome: ConnectOutcome): boolean {
    if (!this.containerEl?.isConnected || this.activeTabId !== "account" || this.searchState.query) return false;
    this.accountConnectOutcome = outcome;
    this.refreshAccountSection();
    return true;
  }

  refreshAccountSection(): void {
    this.invalidateSearchIndex();
    this.syncPhoneCaptureVisibility();
    const account = this.contentContainerEl?.querySelector<HTMLElement>('[data-settings-section="account-0"]');
    if (account) this.refreshSection(account);
  }

  /**
   * Closing settings leaves a browser sign-in started here without its
   * screen, so it polls at the slower background cadence (#359) until it
   * completes or expires.
   */
  private backgroundUnfinishedSignIn(): void {
    const plugin = this.plugin as Partial<Pick<SystemSculptPlugin, "getAccountConnectService">>;
    if (typeof plugin.getAccountConnectService !== "function") return;
    plugin.getAccountConnectService().pollInBackground();
  }

  private disposeRender(): void {
    this.invalidateRenderCleanups();
    this.sectionRenderers.clear();
    this.renderedTabs.clear();
    this.allSettingsIndex = [];
    this.searchIndexDirty = true;
    this.tabsHandle?.destroy();
    this.tabsHandle = null;
    this.searchCombobox?.destroy();
    this.searchCombobox = null;
    this.searchHandle?.destroy();
    this.searchHandle = null;
    if (this.focusTabEventRef) {
      this.app.workspace.offref(this.focusTabEventRef);
      this.focusTabEventRef = null;
    }
  }

  /**
   * Build an index of all `.setting-item` elements across tabs for fast search
   */
  private activateTab(tabId: string) {
    this.tabsHandle?.activate(tabId);
    this.renderTab(tabId);
  }

  private handleTabChange(tabId: string): void {
    if (!this.contentContainerEl) return;
    this.activeTabId = tabId;
    this.renderTab(tabId);
    this.searchIndexDirty = true;
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
      onCommit: ({ item }) => this.navigateToSetting(item),
      onEscape: () => this.clearSearch(true),
    });
  }

  /**
   * Build an index of all `.setting-item` elements across tabs for fast search
   */
  private buildSettingsIndex() {
    this.syncPhoneCaptureVisibility();
    this.allSettingsIndex = [];
    if (!this.contentContainerEl) {
      this.renderSearchMeta();
      return;
    }

    this.allSettingsIndex = buildSettingsIndexFromRoot(
      this.contentContainerEl,
      this.tabsDef,
    );
    for (const entry of getSettingsCatalog(this.plugin.settings)) {
      const panel = this.contentContainerEl.querySelector<HTMLElement>(`[data-tab="${entry.tabId}"]`);
      if (this.renderedTabs.has(entry.tabId) && !panel?.querySelector("[data-settings-dirty]")) continue;
      if (this.allSettingsIndex.some((existing) => existing.settingId === entry.id)) continue;
      const tab = this.tabsDef.find((candidate) => candidate.id === entry.tabId);
      if (!tab) continue;
      this.allSettingsIndex.push({ ...entry, settingId: entry.id, tabLabel: tab.label, kind: "setting" });
    }
    for (const tab of this.tabConfigs) {
      if (this.renderedTabs.has(tab.id) || !tab.anchor) continue;
      this.allSettingsIndex.push({
        tabId: tab.id, tabLabel: tab.label, title: tab.anchor.title,
        description: tab.anchor.desc, kind: "anchor",
      });
    }
    this.searchIndexDirty = false;
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

    if (this.searchIndexDirty) this.buildSettingsIndex();
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
    if (
      this.searchInputEl &&
      this.searchInputEl.ownerDocument.activeElement !== this.searchInputEl
    ) {
      try {
        this.searchInputEl.focus({ preventScroll: true });
      } catch {
        this.searchInputEl.focus();
      }
    }
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
    this.searchIndexDirty = true;
    this.searchHandle?.setValue("", { notify: false });
    this.searchCombobox?.setQuery("", {
      writeInput: false,
      render: false,
    });
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
    const row = groupResults.createDiv({ cls: "ss-search-result" });

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
    if (!match.element) return `${match.tabId}:${match.settingId ?? match.title}`;
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
  private navigateToSetting(match: SettingsSearchMatch) {
    if (!this.tabContainerEl || !this.contentContainerEl) return;

    this.clearSearch(false);
    this.activateTab(match.tabId);
    const panel = this.contentContainerEl.querySelector<HTMLElement>(`[data-tab="${match.tabId}"]`);
    const element = match.settingId
      ? panel?.querySelector<HTMLElement>(`[data-ss-setting="${match.settingId}"]`)
      : match.element ?? panel;
    if (!element) return;

    // Scroll to element and highlight
    const ownerWindow = this.containerEl.ownerDocument.defaultView ?? window;
    ownerWindow.setTimeout(() => {
      try {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        element.addClass("ss-search-highlight");
        ownerWindow.setTimeout(() => element.removeClass("ss-search-highlight"), 1200);
      } catch {
        // If element no longer exists (mode switch), just ensure tab is visible
      }
    }, 50);
  }
}
