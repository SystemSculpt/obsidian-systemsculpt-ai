import { Notice, Platform, Setting, setIcon } from "obsidian";
import type { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import {
  listStudioPiProviderAuthRecords,
  readStudioPiProviderAuthState,
  setStudioPiProviderApiKey,
  clearStudioPiProviderAuth,
  listStudioPiOAuthProviders,
  type StudioPiProviderAuthRecord,
  type StudioPiOAuthProvider,
} from "../studio/piAuth/StudioPiAuthStorage";
import {
  getApiKeyEnvVarForProvider,
  resolveProviderLabel,
  supportsOAuthLogin,
  selectDefaultAuthMethod,
  getDefaultStudioPiProviderHints,
  buildApiKeyHint,
} from "../studio/piAuth/StudioPiProviderRegistry";
import { runStudioPiOAuthLoginFlow } from "../studio/piAuth/StudioPiOAuthLoginFlow";
import { openExternalUrlForOAuth } from "../utils/oauthUiHelpers";
import { collectSharedPiProviderHints, listLocalPiProviderIds } from "../services/pi/PiTextModels";
import { PlatformContext } from "../services/PlatformContext";
import { showPopup } from "../core/ui/modals/PopupModal";

// ─── Types ──────────────────────────────────────────────────────────────────

type ProviderRowState = {
  record: StudioPiProviderAuthRecord;
  expanding: boolean;
};

type TabState = {
  providers: ProviderRowState[];
  loading: boolean;
  errorMessage: string | null;
  piReady: boolean;
  oauthProvidersById: Map<string, StudioPiOAuthProvider>;
  /** True when Pi SDK auth module loaded successfully (false in Obsidian sandbox on some platforms). */
  inModalAuthAvailable: boolean;
  activeConnectProvider: string | null;
  activeConnectMethod: "oauth" | "api_key" | null;
  actionRunning: boolean;
  oauthAbortController: AbortController | null;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalize(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function providerLabel(
  providerId: string,
  oauthProviders?: Map<string, StudioPiOAuthProvider>
): string {
  return resolveProviderLabel(providerId, oauthProviders);
}

function authSummary(record: StudioPiProviderAuthRecord): string {
  if (!record.hasAnyAuth) return "Not connected";
  switch (record.source) {
    case "oauth":
      return "Connected via subscription";
    case "api_key":
      return "Connected via API key";
    case "environment_or_fallback":
      return "Connected from environment";
    default:
      return "Connected";
  }
}

// ─── Main renderer ──────────────────────────────────────────────────────────

export async function displayProvidersTabContent(
  containerEl: HTMLElement,
  tabInstance: SystemSculptSettingTab
): Promise<void> {
  containerEl.empty();
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "providers";
  }

  const { plugin } = tabInstance;

  // Desktop-only gate — this entire tab is hidden on mobile via the registry,
  // but guard defensively in case it's rendered directly.
  if (!PlatformContext.get().supportsDesktopOnlyFeatures()) {
    containerEl.createEl("p", {
      text: "Provider connections are managed on desktop. Mobile uses SystemSculpt.",
      cls: "setting-item-description",
    });
    return;
  }

  const state: TabState = {
    providers: [],
    loading: true,
    errorMessage: null,
    piReady: false,
    oauthProvidersById: new Map(),
    inModalAuthAvailable: true,
    activeConnectProvider: null,
    activeConnectMethod: null,
    actionRunning: false,
    oauthAbortController: null,
  };

  // Cleanup callback for tab deactivation
  (containerEl as any).cleanup = () => {
    state.oauthAbortController?.abort();
    state.oauthAbortController = null;
  };

  const render = () => renderProvidersList(containerEl, tabInstance, state, render);

  // Initial render with loading state
  render();

  // Load providers — Pi SDK is always available as a direct dependency.
  state.piReady = true;

  try {
    const oauthProviders = await listStudioPiOAuthProviders();
    state.inModalAuthAvailable = true;
    state.oauthProvidersById = new Map(
      oauthProviders.map((p) => [normalize(p.id), p])
    );
  } catch {
    // Obsidian sandbox blocks module load — terminal fallback only
    state.inModalAuthAvailable = false;
  }

  await refreshProviderList(state, plugin);
  render();
}

// ─── Provider list refresh ──────────────────────────────────────────────────

async function refreshProviderList(
  state: TabState,
  plugin: any
): Promise<void> {
  state.loading = true;
  state.errorMessage = null;
  try {
    const hints = collectSharedPiProviderHints(plugin.settings.customProviders || []);
    const records = await listStudioPiProviderAuthRecords({ providerHints: hints });

    // Sort: connected first, then alphabetical
    records.sort((a, b) => {
      if (a.hasAnyAuth !== b.hasAnyAuth) return a.hasAnyAuth ? -1 : 1;
      const labelA = providerLabel(a.provider, state.oauthProvidersById);
      const labelB = providerLabel(b.provider, state.oauthProvidersById);
      return labelA.localeCompare(labelB);
    });

    state.providers = records.map((record) => ({
      record,
      expanding: state.activeConnectProvider === record.provider,
    }));
  } catch (error) {
    state.errorMessage =
      error instanceof Error ? error.message : "Failed to load providers.";
    state.providers = [];
  } finally {
    state.loading = false;
  }
}

// ─── Render ─────────────────────────────────────────────────────────────────

function renderProvidersList(
  containerEl: HTMLElement,
  tabInstance: SystemSculptSettingTab,
  state: TabState,
  rerender: () => void
): void {
  containerEl.empty();
  const { plugin } = tabInstance;

  containerEl.createEl("h3", { text: "Providers" });
  containerEl.createEl("p", {
    text: "Connect your own AI provider accounts to use in Chat and Studio. Models from connected providers appear in the model picker.",
    cls: "setting-item-description",
  });

  // Refresh button
  const headerActions = new Setting(containerEl)
    .setName("Connected providers")
    .setDesc(
      state.loading
        ? "Loading providers…"
        : state.errorMessage
          ? state.errorMessage
          : `${state.providers.filter((p) => p.record.hasAnyAuth).length} connected`
    );

  headerActions.addButton((button) => {
    button
      .setIcon("refresh-cw")
      .setTooltip("Refresh provider status")
      .setDisabled(state.loading || state.actionRunning)
      .onClick(async () => {
        button.setDisabled(true);
        await refreshProviderList(state, plugin);
        rerender();
        button.setDisabled(false);
      });
  });

  if (state.loading) {
    containerEl.createDiv({
      cls: "ss-providers-loading",
      text: "Checking provider connections…",
    });
    return;
  }

  if (state.errorMessage && state.providers.length === 0) {
    containerEl.createDiv({
      cls: "ss-providers-error",
      text: state.errorMessage,
    });
    return;
  }

  // Provider rows
  const listEl = containerEl.createDiv({ cls: "ss-providers-list" });

  for (const providerState of state.providers) {
    renderProviderRow(listEl, tabInstance, state, providerState, rerender);
  }
}

function renderProviderRow(
  listEl: HTMLElement,
  tabInstance: SystemSculptSettingTab,
  state: TabState,
  providerState: ProviderRowState,
  rerender: () => void
): void {
  const { plugin } = tabInstance;
  const { record } = providerState;
  const label = providerLabel(record.provider, state.oauthProvidersById);
  const connected = record.hasAnyAuth;
  const isExpanded =
    state.activeConnectProvider === record.provider;

  const row = listEl.createDiv({
    cls: `ss-provider-row ${connected ? "ss-provider-row--connected" : "ss-provider-row--disconnected"}`,
  });

  // ── Header ──
  const header = row.createDiv({ cls: "ss-provider-row__header" });

  const statusDot = header.createSpan({ cls: "ss-provider-row__status-dot" });
  statusDot.setAttribute("aria-label", connected ? "Connected" : "Not connected");

  const info = header.createDiv({ cls: "ss-provider-row__info" });
  info.createDiv({ cls: "ss-provider-row__name", text: label });
  info.createDiv({
    cls: "ss-provider-row__auth-summary",
    text: authSummary(record),
  });

  const actions = header.createDiv({ cls: "ss-provider-row__actions" });

  if (connected) {
    // Disconnect button
    const disconnectBtn = actions.createEl("button", {
      cls: "ss-provider-row__btn ss-provider-row__btn--disconnect",
      text: "Disconnect",
    });
    disconnectBtn.disabled = state.actionRunning;
    disconnectBtn.addEventListener("click", async () => {
      state.actionRunning = true;
      rerender();
      try {
        await clearStudioPiProviderAuth(record.provider);
        new Notice(`Disconnected ${label}.`);
        await refreshProviderList(state, plugin);
      } catch (error) {
        new Notice(
          `Failed to disconnect ${label}: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        state.actionRunning = false;
        rerender();
      }
    });
  } else {
    // Connect button (toggle expand)
    const connectBtn = actions.createEl("button", {
      cls: "ss-provider-row__btn ss-provider-row__btn--connect",
      text: isExpanded ? "Cancel" : "Connect",
    });
    connectBtn.disabled = state.actionRunning;
    connectBtn.addEventListener("click", () => {
      if (isExpanded) {
        state.activeConnectProvider = null;
        state.activeConnectMethod = null;
        state.oauthAbortController?.abort();
        state.oauthAbortController = null;
      } else {
        state.activeConnectProvider = record.provider;
        state.activeConnectMethod = selectDefaultAuthMethod(
          record.provider,
          state.oauthProvidersById
        );
      }
      rerender();
    });
  }

  // ── Expanded connect panel ──
  if (isExpanded && !connected) {
    renderConnectPanel(row, tabInstance, state, record, rerender);
  }
}

// ─── Connect panel ──────────────────────────────────────────────────────────

function renderConnectPanel(
  row: HTMLElement,
  tabInstance: SystemSculptSettingTab,
  state: TabState,
  record: StudioPiProviderAuthRecord,
  rerender: () => void
): void {
  const { plugin } = tabInstance;
  const panel = row.createDiv({ cls: "ss-provider-connect-panel" });
  const providerId = record.provider;
  const label = providerLabel(providerId, state.oauthProvidersById);
  const hasOAuth = supportsOAuthLogin(providerId, state.oauthProvidersById);
  const envVar = getApiKeyEnvVarForProvider(providerId);

  // Method tabs (if both are available)
  if (hasOAuth && envVar) {
    const methods = panel.createDiv({ cls: "ss-provider-connect-methods" });

    const oauthBtn = methods.createEl("button", {
      cls: `ss-provider-connect-method ${state.activeConnectMethod === "oauth" ? "ss-provider-connect-method--active" : ""}`,
      text: "Subscription login",
    });
    oauthBtn.disabled = state.actionRunning;
    oauthBtn.addEventListener("click", () => {
      state.activeConnectMethod = "oauth";
      rerender();
    });

    const apiKeyBtn = methods.createEl("button", {
      cls: `ss-provider-connect-method ${state.activeConnectMethod === "api_key" ? "ss-provider-connect-method--active" : ""}`,
      text: "API key",
    });
    apiKeyBtn.disabled = state.actionRunning;
    apiKeyBtn.addEventListener("click", () => {
      state.activeConnectMethod = "api_key";
      rerender();
    });
  } else {
    // Force the only available method
    state.activeConnectMethod = hasOAuth ? "oauth" : "api_key";
  }

  if (state.activeConnectMethod === "oauth") {
    renderOAuthConnect(panel, tabInstance, state, providerId, label, rerender);
  } else {
    renderApiKeyConnect(panel, tabInstance, state, providerId, label, envVar, rerender);
  }
}

// ─── OAuth connect ──────────────────────────────────────────────────────────

function renderOAuthConnect(
  panel: HTMLElement,
  tabInstance: SystemSculptSettingTab,
  state: TabState,
  providerId: string,
  label: string,
  rerender: () => void
): void {
  const { plugin } = tabInstance;
  const body = panel.createDiv({ cls: "ss-provider-connect-body" });

  body.createDiv({
    cls: "ss-provider-connect-hint",
    text: `Sign in with your ${label} account. A browser window will open.`,
  });

  const loginBtn = body.createEl("button", {
    cls: "mod-cta",
    text: `Continue with ${label}`,
  });
  loginBtn.disabled = state.actionRunning || !state.piReady;
  loginBtn.addEventListener("click", async () => {
    state.actionRunning = true;
    state.oauthAbortController?.abort();
    const abortController = new AbortController();
    state.oauthAbortController = abortController;
    rerender();

    try {
      await runStudioPiOAuthLoginFlow({
        providerId,
        onAuth: async (info) => {
          if (info.url) {
            await openExternalUrlForOAuth(info.url);
          }
        },
        onPrompt: async (prompt) => {
          const result = await showPopup(
            plugin.app,
            prompt.message || "Enter value:",
            {
              primaryButton: "Submit",
              secondaryButton: "Cancel",
              inputs: [{ type: "text", placeholder: prompt.placeholder || "" }],
            }
          );
          if (!result?.confirmed || !result.inputs?.[0]) throw new Error("Login cancelled.");
          return result.inputs[0];
        },
        onProgress: () => {},
        onManualCodeInput: async () => {
          const result = await showPopup(
            plugin.app,
            "Paste the authorization code or redirect URL:",
            {
              primaryButton: "Submit",
              secondaryButton: "Cancel",
              inputs: [{ type: "text", placeholder: "https://…" }],
            }
          );
          if (!result?.confirmed || !result.inputs?.[0]) throw new Error("Login cancelled.");
          return result.inputs[0];
        },
        signal: abortController.signal,
      });

      new Notice(`${label} connected successfully.`);
      state.activeConnectProvider = null;
      state.activeConnectMethod = null;
      await refreshProviderList(state, plugin);
    } catch (error) {
      if (abortController.signal.aborted) return;
      new Notice(
        `${label} login failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      state.oauthAbortController = null;
      state.actionRunning = false;
      rerender();
    }
  });
}

// ─── API key connect ────────────────────────────────────────────────────────

function renderApiKeyConnect(
  panel: HTMLElement,
  tabInstance: SystemSculptSettingTab,
  state: TabState,
  providerId: string,
  label: string,
  envVar: string,
  rerender: () => void
): void {
  const { plugin } = tabInstance;
  const body = panel.createDiv({ cls: "ss-provider-connect-body" });

  body.createDiv({
    cls: "ss-provider-connect-hint",
    text: buildApiKeyHint(providerId, envVar || undefined),
  });

  if (!state.inModalAuthAvailable) {
    if (envVar) {
      body.createDiv({
        cls: "ss-provider-connect-hint",
        text: `Set ${envVar} in your environment before launching Obsidian, then refresh.`,
      });
    }
    return;
  }

  const inputRow = body.createDiv({ cls: "ss-provider-connect-input-row" });
  const input = inputRow.createEl("input", {
    cls: "ss-provider-connect-input",
    type: "password",
    placeholder: envVar ? `Paste ${envVar} value` : "Paste your API key",
  });
  input.addEventListener("focus", () => { input.type = "text"; });
  input.addEventListener("blur", () => { input.type = "password"; });

  const saveBtn = inputRow.createEl("button", {
    cls: "mod-cta",
    text: "Save",
  });
  saveBtn.disabled = state.actionRunning || !state.piReady;

  const handleSave = async () => {
    const key = input.value.trim();
    if (!key) {
      new Notice("Enter an API key first.");
      return;
    }
    state.actionRunning = true;
    rerender();
    try {
      await setStudioPiProviderApiKey(providerId, key);
      new Notice(`${label} API key saved.`);
      state.activeConnectProvider = null;
      state.activeConnectMethod = null;
      await refreshProviderList(state, plugin);
    } catch (error) {
      new Notice(
        `Failed to save API key: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      state.actionRunning = false;
      rerender();
    }
  };

  saveBtn.addEventListener("click", handleSave);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSave();
    }
  });
}
