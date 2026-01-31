import { App, PluginSettingTab, Setting, Notice, setIcon, ButtonComponent, Platform, EventRef } from "obsidian";
import { SYSTEMSCULPT_WEBSITE } from "../constants/externalServices";
import { showPopup } from "../core/ui";
import SystemSculptPlugin from "../main";
import { VersionInfo } from "../services/VersionCheckerService";
import { buildSettingsIndexFromRoot } from "./SettingsSearchIndex";
import { buildSettingsTabConfigs } from "./SettingsTabRegistry";
import { decorateRestoreDefaultsButton, RESTORE_DEFAULTS_COPY } from "./uiHelpers";

export class SystemSculptSettingTab extends PluginSettingTab {
  plugin: SystemSculptPlugin;
  private debounceTimer: NodeJS.Timeout | null = null;
  private listeners: { element: HTMLElement; type: string; listener: EventListener }[] = [];
  private versionInfoContainer: HTMLElement | null = null;
  private tabContainerEl: HTMLElement | null = null;
  private contentContainerEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private searchResultsContainerEl: HTMLElement | null = null;
  private allSettingsIndex: {
    tabId: string;
    tabLabel: string;
    title: string;
    description: string;
    element: HTMLElement;
  }[] = [];
  private tabsDef: { id: string; label: string }[] = [];
  private contentMutationObserver: MutationObserver | null = null;
  private indexRebuildTimer: number | null = null;
  private activeTabId: string = "overview";
  private focusTabEventRef: EventRef | null = null;

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  registerListener(element: HTMLElement, type: string, listener: EventListener) {
    element.addEventListener(type, listener);
    this.listeners.push({ element, type, listener });
  }

  private generateFeedbackUrl(): string {
    const environmentInfo: string[] = [];
    
    // Plugin version - always available
    environmentInfo.push(`- SystemSculpt AI version: ${this.plugin.manifest.version}`);
    
    // Obsidian version
    const obsidianVersion = (this.app as any).apiVersion || 
                           (this.app as any).vault?.config?.version || 
                           '';
    if (obsidianVersion) {
      environmentInfo.push(`- Obsidian version: ${obsidianVersion}`);
    }
    
    // OS
    let os = '';
    if (Platform.isWin) {
      os = 'Windows';
    } else if (Platform.isMacOS) {
      os = 'macOS';
    } else if (Platform.isLinux) {
      os = 'Linux';
    } else if (Platform.isIosApp) {
      os = 'iOS';
    } else if (Platform.isAndroidApp) {
      os = 'Android';
    }
    if (os) {
      environmentInfo.push(`- OS: ${os}`);
    }
    
    // Device type
    let deviceType = '';
    if (Platform.isDesktopApp) {
      deviceType = 'Desktop';
    } else if (Platform.isMobileApp) {
      deviceType = 'Mobile';
    } else if (Platform.isTablet) {
      deviceType = 'Tablet';
    }
    if (deviceType) {
      environmentInfo.push(`- Device type: ${deviceType}`);
    }
    
    // Theme
    const isDarkTheme = document.body.classList.contains('theme-dark');
    environmentInfo.push(`- Theme: ${isDarkTheme ? 'Dark' : 'Light'}`);
    
    // Language/Locale
    if (navigator.language) {
      environmentInfo.push(`- Language: ${navigator.language}`);
    }
    
    // Current AI Provider (prefer active provider name if available)
    const activeProvider = this.plugin.settings.activeProvider;
    const currentProvider = activeProvider?.name || this.plugin.settings.selectedProvider;
    if (currentProvider) {
      environmentInfo.push(`- AI Provider: ${currentProvider}`);
    }
    
    // Current Model
    const currentModel = this.plugin.settings.selectedModelId;
    if (currentModel) {
      environmentInfo.push(`- AI Model: ${currentModel}`);
    }
    
    // Plugin Mode (Standard or Advanced)
    const pluginMode = this.plugin.settings.settingsMode === 'advanced' ? 'Advanced' : 'Standard';
    environmentInfo.push(`- Plugin mode: ${pluginMode}`);
    
    // Vault Statistics (privacy-conscious)
    const files = this.app.vault.getFiles();
    const noteCount = files.filter(f => f.extension === 'md').length;
    let vaultSize = '';
    if (noteCount < 100) vaultSize = 'Small (<100 notes)';
    else if (noteCount < 500) vaultSize = 'Medium (100-500 notes)';
    else if (noteCount < 2000) vaultSize = 'Large (500-2000 notes)';
    else vaultSize = 'Very Large (2000+ notes)';
    environmentInfo.push(`- Vault size: ${vaultSize}`);
    
    // Enabled Features
    const enabledFeatures: string[] = ['MCP']; // MCP is always enabled (internal servers)
    if (this.plugin.settings.embeddingsEnabled) enabledFeatures.push('Embeddings');
    if (this.plugin.settings.enableSystemSculptProvider) enabledFeatures.push('SystemSculpt Provider');

    if (enabledFeatures.length > 0) {
      environmentInfo.push(`- Enabled features: ${enabledFeatures.join(', ')}`);
    }

    // Enabled custom providers (if any)
    const enabledCustomProviders = (this.plugin.settings.customProviders || []).filter(p => p.isEnabled).map(p => p.name).filter(Boolean);
    if (enabledCustomProviders.length > 0) {
      environmentInfo.push(`- Custom providers enabled: ${enabledCustomProviders.join(', ')}`);
    }
    
    const title = encodeURIComponent('SystemSculpt Feedback: ');
    const body = encodeURIComponent(
      `Please describe your feedback:\n\n` +
      `- What happened or what would you like to see improved?\n` +
      `- Steps to reproduce (if a bug):\n` +
      `- Expected behavior:\n` +
      `- Screenshots or logs:\n\n` +
      `Environment:\n` +
      environmentInfo.join('\n') + '\n\n' +
      `Additional context:`
    );

    return `https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues/new?title=${title}&body=${body}`;
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

  containerEl.createEl("h2", { text: "SystemSculpt AI" });
  containerEl.createEl("p", {
    text: "Configure AI models, prompts, embeddings, audio, and more.",
    cls: "setting-item-description",
  });

  const versionSetting = new Setting(containerEl)
    .setName("Plugin version")
    .setDesc("");
  versionSetting.controlEl.addClass("ss-inline-actions");
  this.versionInfoContainer = versionSetting.descEl;
  this.initializeVersionDisplay();
  versionSetting.addExtraButton((button) => {
    button
      .setIcon("refresh-cw")
      .setTooltip("Check for updates")
      .onClick(async () => {
        button.setDisabled(true);
        try {
          await this.checkForUpdates(true);
        } finally {
          button.setDisabled(false);
        }
      });
  });

  const modeSetting = new Setting(containerEl)
    .setName("Settings mode")
    .setDesc("Standard hides advanced options. Advanced unlocks everything.");
  modeSetting.addDropdown((dropdown) => {
    dropdown
      .addOption("standard", "Standard")
      .addOption("advanced", "Advanced")
      .setValue((this.plugin.settings.settingsMode ?? "standard") as string)
      .onChange(async (value) => {
        const nextMode = value === "advanced" ? "advanced" : "standard";
        if (nextMode === this.plugin.settings.settingsMode) {
          return;
        }
        await this.plugin.getSettingsManager().updateSettings({ settingsMode: nextMode as any });
        this.display();
      });
  });

  const searchSetting = new Setting(containerEl)
    .setName("Search settings")
    .setDesc("Search across every tab.");
    searchSetting.addText((text) => {
      text.setPlaceholder("Search settings...");
    text.setValue("");
    text.inputEl.type = "search";
    text.inputEl.addClass("search-input");
    this.searchInputEl = text.inputEl;
    this.registerListener(text.inputEl, "input", () => this.handleSearchInput());
    this.registerListener(text.inputEl, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.searchInputEl) {
        this.searchInputEl.value = "";
        this.exitSearchMode();
        this.searchInputEl.focus();
      }
    });
  });
  searchSetting.addExtraButton((button) => {
    button
      .setIcon("x-circle")
      .setTooltip("Clear search")
      .onClick(() => {
        if (!this.searchInputEl) return;
        this.searchInputEl.value = "";
        this.exitSearchMode();
        this.searchInputEl.focus();
      });
  });

  const actionsSetting = new Setting(containerEl)
    .setName("Quick actions")
    .setDesc("");
  actionsSetting.addButton((button) => {
    decorateRestoreDefaultsButton(button.buttonEl);
    button.onClick(async () => {
      const confirm = await showPopup(
        this.app,
        RESTORE_DEFAULTS_COPY.label,
        {
          description:
            "This will replace your current configuration with the recommended defaults. Any customizations you've applied will be overwritten. Do you want to continue?",
          primaryButton: "Restore Defaults",
          secondaryButton: "Cancel",
        }
      );
      if (!confirm?.confirmed) {
        return;
      }

      try {
        button.setDisabled(true);
        await this.plugin.getSettingsManager().updateSettings({
          settingsMode: "standard",
          selectedModelId: this.plugin.settings.selectedModelId || "systemsculpt@@moonshotai/kimi-k2",
          systemPromptType: "general-use",
          systemPromptPath: "",
          chatFontSize: "medium",
          selectedModelProviders: [],
          embeddingsEnabled: false,
          showModelTooltips: false,
          showVisionModelsOnly: false,
          showTopPicksOnly: false,
          chatsDirectory: "SystemSculpt/Chats",
          savedChatsDirectory: "SystemSculpt/Saved Chats",
          benchmarksDirectory: "SystemSculpt/Benchmarks",
          attachmentsDirectory: "SystemSculpt/Attachments",
          extractionsDirectory: "SystemSculpt/Extractions",
          systemPromptsDirectory: "SystemSculpt/System Prompts",
          showUpdateNotifications: true,
          debugMode: false,
        });
        new Notice("Recommended defaults restored.", 2500);
        this.display();
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
  setIcon(feedbackLink.createSpan({ cls: "ss-settings-link-icon" }), "external-link");

  const layout = containerEl.createDiv({ cls: "ss-settings-layout" });
  const tabBar = layout.createDiv({ cls: "ss-settings-tab-bar" });
  const contentContainer = layout.createDiv({ cls: "ss-settings-panels" });

  this.tabContainerEl = tabBar;
  this.contentContainerEl = contentContainer;

  const tabConfigsAll = buildSettingsTabConfigs(this);
  const isAdvancedMode = this.plugin.settings.settingsMode === "advanced";
  const visibleTabs = isAdvancedMode
    ? tabConfigsAll
    : tabConfigsAll.filter((cfg) =>
        ["overview", "models-prompts", "chat-templates", "daily-vault", "embeddings", "audio-transcription"].includes(cfg.id)
      );

  if (this.focusTabEventRef) {
    this.app.workspace.offref(this.focusTabEventRef);
    this.focusTabEventRef = null;
  }
  this.focusTabEventRef = this.app.workspace.on("systemsculpt:settings-focus-tab", (requestedTab: string) => {
    if (!requestedTab) return;
    if (!this.tabContainerEl) return;
    const target = this.tabContainerEl.querySelector(`button[data-tab="${requestedTab}"]`) as HTMLElement | null;
    if (!target) return;
    this.exitSearchMode();
    this.activateTab(requestedTab);
  });

  this.tabsDef = visibleTabs.map(({ id, label }) => ({ id, label }));
  this.activeTabId = this.tabsDef[0]?.id ?? "overview";

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
    const sectionRoot = contentContainer.querySelector(`[data-tab="${cfg.id}"]`) as HTMLElement | null;
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

  if (!isAdvancedMode) {
    const hiddenConfigs = tabConfigsAll.filter((cfg) => !visibleTabs.find((c) => c.id === cfg.id));
    for (const cfg of hiddenConfigs) {
      const hiddenPanel = contentContainer.createDiv({
        cls: ["ss-tab-panel", "systemsculpt-tab-content"],
      });
      hiddenPanel.dataset.tab = cfg.id;
      hiddenPanel.toggle(false);
      if (cfg.anchor) {
        const anchor = hiddenPanel.createDiv({
          attr: {
            "data-ss-search": "true",
            "data-ss-title": cfg.anchor.title,
            "data-ss-desc": cfg.anchor.desc,
            "data-ss-advanced": "true",
          },
        });
        anchor.toggle(false);
      }
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
      this.indexRebuildTimer = window.setTimeout(() => this.buildSettingsIndex(), 150);
    });
    this.contentMutationObserver.observe(this.contentContainerEl, { childList: true, subtree: true });
  }

  this.searchResultsContainerEl = containerEl.createDiv({ cls: "ss-settings-search-results" });
  this.searchResultsContainerEl.toggle(false);
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
      text: `v${currentVersion} (checking...)`
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
      const versionInfo = await this.plugin.getVersionCheckerService().checkVersion(forceRefresh);
      this.updateVersionDisplay(versionInfo);
    } catch (error) {

      const versionText = this.versionInfoContainer.querySelector(".ss-version-pill") as HTMLElement | null;
      if (versionText) {
        versionText.setText(`v${this.plugin.manifest.version} (check failed)`);
        versionText.removeClass("ss-version-pill--latest", "ss-version-pill--outdated", "ss-version-pill--checking");
        versionText.addClass("ss-version-pill--error");
      }
    }
  }

  /**
   * Update the version display with the version info
   */
  private updateVersionDisplay(versionInfo: VersionInfo) {
    if (!this.versionInfoContainer) return;

    let versionText = this.versionInfoContainer.querySelector(".ss-version-pill") as HTMLElement | null;
    if (!versionText) {
      versionText = this.versionInfoContainer.createSpan({ cls: "ss-version-pill" });
    }

    versionText.removeClass(
      "ss-version-pill--latest",
      "ss-version-pill--outdated",
      "ss-version-pill--error",
      "ss-version-pill--checking"
    );

    if (versionInfo.isLatest) {
      versionText.setText(`v${versionInfo.currentVersion} (latest)`);
      versionText.addClass("ss-version-pill--latest");
      this.versionInfoContainer.querySelector(".ss-version-update")?.remove();
    } else {
      versionText.setText(`v${versionInfo.currentVersion} → v${versionInfo.latestVersion}`);
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
            10000
          );
        });
      }
    }
  }

  // Override hide method to clean up event listeners
  hide() {
    // Clean up resources from the currently active tab before closing
    const activeContent = this.containerEl.querySelector(".systemsculpt-tab-content.is-active") as any;
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

    const targetPanel = this.contentContainerEl.querySelector(`.systemsculpt-tab-content[data-tab="${tabId}"]`) as any;
    const activePanel = this.contentContainerEl.querySelector(".systemsculpt-tab-content.is-active") as any;
    if (activePanel && activePanel !== targetPanel && typeof activePanel?.cleanup === "function") {
      try {
        activePanel.cleanup();
      } catch (_) {
        // ignore cleanup failures
      }
    }

    this.activeTabId = tabId;

    Array.from(this.tabContainerEl.querySelectorAll("button[data-tab]"))
      .forEach((button) => {
        const el = button as HTMLElement;
        if (el.dataset.tab === tabId) {
          el.addClass("mod-active", "mod-cta");
        } else {
          el.removeClass("mod-active", "mod-cta");
        }
      });

    Array.from(this.contentContainerEl.querySelectorAll(".systemsculpt-tab-content"))
      .forEach((panel) => {
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
    if (!this.contentContainerEl) return;

    this.allSettingsIndex = buildSettingsIndexFromRoot(this.contentContainerEl, this.tabsDef);
  }

  /**
   * Handle search input with debounce
   */
  private handleSearchInput() {
    if (!this.searchInputEl) return;
    const query = this.searchInputEl.value.trim();

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer as any);
    }
    this.debounceTimer = setTimeout(() => {
      if (query.length === 0) {
        this.exitSearchMode();
      } else {
        this.enterSearchMode(query);
      }
    }, 200);
  }

  /**
   * Enter search mode: hide tabs, show results
   */
  private enterSearchMode(query: string) {
    if (!this.tabContainerEl || !this.contentContainerEl || !this.searchResultsContainerEl) return;

    this.tabContainerEl.toggle(false);
    Array.from(this.contentContainerEl.querySelectorAll(".systemsculpt-tab-content"))
      .forEach((panel) => (panel as HTMLElement).toggle(false));

    this.renderSearchResults(query);
    this.searchResultsContainerEl.toggle(true);
  }

  /**
   * Exit search mode: show tabs and active content, hide results
   */
  private exitSearchMode() {
    if (!this.tabContainerEl || !this.contentContainerEl || !this.searchResultsContainerEl) return;
    this.searchResultsContainerEl.toggle(false);
    this.tabContainerEl.toggle(true);
    this.activateTab(this.activeTabId);
  }

  /**
   * Render search results list
   */
  private renderSearchResults(query: string) {
    if (!this.searchResultsContainerEl) return;
    const q = query.toLowerCase();
    const matches = this.allSettingsIndex.filter((item) =>
      item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)
    );

    this.searchResultsContainerEl.empty();

    const header = this.searchResultsContainerEl.createDiv({ cls: "ss-search-header" });
    header.createSpan({ text: `Search results (${matches.length})`, cls: "ss-search-count" });

    if (matches.length === 0) {
      this.searchResultsContainerEl.createDiv({ cls: "ss-search-empty", text: "No settings match your search." });
      return;
    }

    for (const match of matches) {
      const row = this.searchResultsContainerEl.createDiv({ cls: "ss-search-result" });
      row.createDiv({ cls: "ss-search-title", text: match.title || "(Untitled setting)" });
      if (match.description) {
        row.createDiv({ cls: "ss-search-desc", text: match.description });
      }
      const isAdvancedOnly = !this.tabsDef.find((tab) => tab.id === match.tabId);
      row.createDiv({
        cls: "ss-search-tab",
        text: isAdvancedOnly ? `${match.tabLabel} • Requires Advanced` : match.tabLabel,
      });
      row.addEventListener("click", () => this.navigateToSetting(match.tabId, match.element));
    }
  }

  /**
   * Activate the tab and scroll to the target setting element
   */
  private navigateToSetting(tabId: string, element: HTMLElement) {
    if (!this.tabContainerEl || !this.contentContainerEl) return;

    // Exit search mode and clear input
    this.exitSearchMode();
    if (this.searchInputEl) this.searchInputEl.value = "";

    const targetButton = this.tabContainerEl.querySelector(`button[data-tab="${tabId}"]`) as HTMLElement | null;
    if (!targetButton) {
      if (this.plugin.settings.settingsMode !== "advanced") {
        this.plugin
          .getSettingsManager()
          .updateSettings({ settingsMode: "advanced" as any })
          .then(() => {
            this.display();
            setTimeout(() => {
              const newBtn = this.tabContainerEl?.querySelector(`button[data-tab="${tabId}"]`) as HTMLElement | null;
              newBtn?.click();
            }, 120);
          });
      }
      return;
    }

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
