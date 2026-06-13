import { Notice, Setting } from "obsidian";
import type { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { CHAT_VIEW_TYPE } from "../core/plugin/viewTypes";
import { generateDefaultChatTitle } from "../utils/titleUtils";
import type { SystemSculptModel } from "../types/llm";
import type {
  StudioPiProviderAuthRecord,
  StudioPiOAuthProvider,
} from "../studio/piAuth/StudioPiAuthInventory";
import {
  getApiKeyEnvVarForProvider,
  getStudioPiLocalProviderSetup,
  getStudioPiAuthMethodRestriction,
  isStudioPiAuthMethodEnabled,
  isStudioPiLocalProvider,
  supportsOAuthLogin,
  selectDefaultAuthMethod,
  buildApiKeyHint,
} from "../studio/piAuth/StudioPiProviderRegistry";
import { openExternalUrlForOAuth } from "../utils/oauthUiHelpers";
import { PlatformContext } from "../services/PlatformContext";
import { OAuthStatusModal } from "../core/ui/modals/OAuthStatusModal";
import {
  formatProviderStatusSummary,
  getProviderDisplayState,
  getProviderLabel,
  getStoredAuthRestriction,
  hasConfiguredLocalProvider,
  loadProviderStatusInventoryWithTimeout,
  normalizeProviderId,
} from "./providerStatus";
import { getPiModelsDisplayPath } from "../services/pi/PiSdkStoragePaths";

// ─── Types ──────────────────────────────────────────────────────────────────

type ProviderRowState = {
  record: StudioPiProviderAuthRecord;
  expanding: boolean;
};

type ProviderModelHint = {
  modelId: string;
  modelName: string;
  providerId: string;
  preferred: boolean;
};

type TabState = {
  providers: ProviderRowState[];
  loading: boolean;
  errorMessage: string | null;
  piReady: boolean;
  localProviderIds: Set<string>;
  oauthProvidersById: Map<string, StudioPiOAuthProvider>;
  providerModelHints: Map<string, ProviderModelHint>;
  /** True when in-modal provider connect actions should be surfaced. */
  inModalAuthAvailable: boolean;
  activeConnectProvider: string | null;
  activeConnectMethod: "oauth" | "api_key" | null;
  actionRunning: boolean;
  oauthAbortController: AbortController | null;
};

async function loadStudioPiAuthInventoryModule(): Promise<
  typeof import("../studio/piAuth/StudioPiAuthInventory")
> {
  return await import("../studio/piAuth/StudioPiAuthInventory");
}

async function loadStudioPiAuthStorageModule(): Promise<
  typeof import("../studio/piAuth/StudioPiAuthStorage")
> {
  return await import("../studio/piAuth/StudioPiAuthStorage");
}

async function loadStudioPiOAuthLoginFlowModule(): Promise<
  typeof import("../studio/piAuth/StudioPiOAuthLoginFlow")
> {
  return await import("../studio/piAuth/StudioPiOAuthLoginFlow");
}

function resolveConnectMethod(
  providerId: string,
  preferredMethod: "oauth" | "api_key" | null,
  oauthProvidersById: Map<string, StudioPiOAuthProvider>
): "oauth" | "api_key" | null {
  const oauthEnabled = isStudioPiAuthMethodEnabled(providerId, "oauth", oauthProvidersById);
  const apiKeyEnabled = isStudioPiAuthMethodEnabled(providerId, "api_key", oauthProvidersById);

  if (preferredMethod === "oauth" && oauthEnabled) {
    return "oauth";
  }
  if (preferredMethod === "api_key" && apiKeyEnabled) {
    return "api_key";
  }
  if (oauthEnabled) {
    return "oauth";
  }
  if (apiKeyEnabled) {
    return "api_key";
  }
  return null;
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

  const state: TabState = {
    providers: [],
    loading: true,
    errorMessage: null,
    piReady: false,
    localProviderIds: new Set(),
    oauthProvidersById: new Map(),
    providerModelHints: new Map(),
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

  // Load provider metadata from the lightweight inventory module first.
  state.piReady = true;

  try {
    const { listStudioPiOAuthProviders } = await loadStudioPiAuthInventoryModule();
    const oauthProviders = await listStudioPiOAuthProviders({ plugin });
    state.inModalAuthAvailable = true;
    state.oauthProvidersById = new Map(
      oauthProviders.map((p) => [normalizeProviderId(p.id), p])
    );
  } catch {
    // If even the lightweight inventory cannot load, keep connect flows disabled.
    state.inModalAuthAvailable = false;
  }

  await refreshProvidersAndModelHints(state, plugin);
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
    const inventory = await loadProviderStatusInventoryWithTimeout(plugin, {
      label: "provider settings",
    });
    state.localProviderIds = inventory.localProviderIds;
    state.oauthProvidersById = inventory.oauthProvidersById;
    state.providers = inventory.records.map((record) => ({
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

function modelMatchesProvider(model: SystemSculptModel, providerId: string): boolean {
  const normalizedProvider = normalizeProviderId(providerId);
  if (!normalizedProvider) {
    return false;
  }
  return (
    normalizeProviderId(model.sourceProviderId) === normalizedProvider ||
    normalizeProviderId(model.provider) === normalizedProvider
  );
}

function pickProviderModelHint(
  providerId: string,
  models: SystemSculptModel[],
): ProviderModelHint | null {
  const normalizedProvider = normalizeProviderId(providerId);
  const providerModels = models.filter((model) => modelMatchesProvider(model, normalizedProvider));
  if (providerModels.length === 0) {
    return null;
  }

  const preferredIds =
    normalizedProvider === "xai"
      ? ["xai@@grok-4.3", "local-pi-xai@@grok-4.3"]
      : [];
  const preferredModel =
    preferredIds
      .map((id) => providerModels.find((model) => model.id === id))
      .find(Boolean) || null;
  const model = preferredModel || providerModels[0];

  return {
    modelId: model.id,
    modelName: String(model.name || model.id || "").trim() || model.id,
    providerId: normalizedProvider,
    preferred: Boolean(preferredModel),
  };
}

function getConnectedRemoteProviderIds(state: TabState): string[] {
  return state.providers
    .map((providerState) => providerState.record)
    .filter((record) => {
      const providerId = normalizeProviderId(record.provider);
      if (!providerId || isStudioPiLocalProvider(providerId)) {
        return false;
      }
      return getProviderDisplayState(record, state.localProviderIds).connected;
    })
    .map((record) => normalizeProviderId(record.provider));
}

async function refreshProviderModelHints(
  state: TabState,
  plugin: SystemSculptSettingTab["plugin"],
  options: { forceRefresh?: boolean; providerIds?: string[] } = {},
): Promise<void> {
  const providerIds = (
    options.providerIds && options.providerIds.length > 0
      ? options.providerIds
      : getConnectedRemoteProviderIds(state)
  )
    .map((providerId) => normalizeProviderId(providerId))
    .filter((providerId) => providerId.length > 0);
  if (providerIds.length === 0) {
    state.providerModelHints = new Map();
    return;
  }

  const modelService = (plugin as any)?.modelService;
  const loadModels =
    options.forceRefresh && typeof modelService?.refreshModels === "function"
      ? () => modelService.refreshModels()
      : typeof modelService?.getModels === "function"
        ? () => modelService.getModels()
        : null;
  if (!loadModels) {
    return;
  }

  try {
    const models = (await loadModels()) as SystemSculptModel[];
    const next = new Map(state.providerModelHints);
    const connectedProviderIds = new Set(getConnectedRemoteProviderIds(state));
    for (const providerId of Array.from(next.keys())) {
      if (!connectedProviderIds.has(providerId)) {
        next.delete(providerId);
      }
    }
    for (const providerId of providerIds) {
      const hint = pickProviderModelHint(providerId, Array.isArray(models) ? models : []);
      if (hint) {
        next.set(providerId, hint);
      } else {
        next.delete(providerId);
      }
    }
    state.providerModelHints = next;
  } catch {
    // Provider status remains useful even when the model catalog is temporarily unavailable.
  }
}

async function refreshProvidersAndModelHints(
  state: TabState,
  plugin: SystemSculptSettingTab["plugin"],
  options: { forceModelRefresh?: boolean; providerIds?: string[] } = {},
): Promise<void> {
  await refreshProviderList(state, plugin);
  if (!state.errorMessage) {
    await refreshProviderModelHints(state, plugin, {
      forceRefresh: options.forceModelRefresh,
      providerIds: options.providerIds,
    });
  }
}

// Optimistically flip the in-memory record for a provider row to the
// disconnected state so a synchronous rerender reflects the click immediately.
// The async clear + refreshProviderList still runs afterwards and will
// reconcile against the canonical state.
function optimisticDisconnectProviderRow(
  state: TabState,
  provider: string,
): void {
  for (const providerState of state.providers) {
    if (providerState.record.provider !== provider) continue;
    providerState.record = {
      ...providerState.record,
      hasAnyAuth: false,
      hasStoredCredential: false,
      source: "none",
      credentialType: "none",
      oauthExpiresAt: null,
    };
  }
}

async function performProviderDisconnect(
  state: TabState,
  plugin: SystemSculptSettingTab["plugin"],
  provider: string,
  label: string,
  rerender: () => void,
): Promise<void> {
  optimisticDisconnectProviderRow(state, provider);
  state.actionRunning = true;
  rerender();
  try {
    const { clearStudioPiProviderAuth } = await loadStudioPiAuthStorageModule();
    await clearStudioPiProviderAuth(provider, { plugin });
    new Notice(`Disconnected ${label}.`);
  } catch (error) {
    new Notice(
      `Failed to disconnect ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await refreshProvidersAndModelHints(state, plugin, {
      forceModelRefresh: true,
      providerIds: [provider],
    });
    state.actionRunning = false;
    rerender();
  }
}

function getProviderReadyText(label: string, hint: ProviderModelHint | undefined): string {
  if (!hint) {
    return `${label} is connected. Refresh models if new provider models do not appear yet.`;
  }
  if (hint.providerId === "xai" && hint.modelId === "xai@@grok-4.3") {
    return "Grok 4.3 is ready in the model picker.";
  }
  return `${hint.modelName} is ready in the model picker.`;
}

async function openProviderModelInChat(
  plugin: SystemSculptSettingTab["plugin"],
  modelId: string,
): Promise<void> {
  await plugin.getSettingsManager().updateSettings({ selectedModelId: modelId });
  const { ChatView } = await import("../views/chatview/ChatView");
  const leaf = plugin.app.workspace.getLeaf("tab");
  await leaf.setViewState({
    type: CHAT_VIEW_TYPE,
    state: {
      chatId: "",
      selectedModelId: modelId,
      chatTitle: generateDefaultChatTitle(),
    },
  });
  const view = new ChatView(leaf, plugin);
  await leaf.open(view);
  plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
}

async function performUseProviderInChat(
  state: TabState,
  plugin: SystemSculptSettingTab["plugin"],
  providerId: string,
  label: string,
  rerender: () => void,
): Promise<void> {
  const normalizedProvider = normalizeProviderId(providerId);
  state.actionRunning = true;
  rerender();
  try {
    await refreshProviderModelHints(state, plugin, {
      forceRefresh: true,
      providerIds: [normalizedProvider],
    });
    const hint = state.providerModelHints.get(normalizedProvider);
    if (!hint) {
      new Notice(`No ${label} models are available yet. Refresh provider status and try again.`);
      return;
    }
    await openProviderModelInChat(plugin, hint.modelId);
    new Notice(`Using ${hint.modelName} in Chat.`);
  } catch (error) {
    new Notice(
      `Failed to open ${label} in Chat: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    state.actionRunning = false;
    rerender();
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
    text: PlatformContext.get().supportsDesktopOnlyFeatures()
      ? "Connect your own AI provider accounts or configure local Pi runtimes to use in Chat and Studio. Models from connected providers and configured local runtimes appear in the model picker."
      : "Connect your own AI provider accounts to use remote models in Chat on mobile. Local Pi runtimes remain desktop-only.",
    cls: "setting-item-description",
  });

  // Refresh button
  const headerActions = new Setting(containerEl)
    .setName("Provider status")
    .setDesc(
      state.loading
        ? "Loading providers…"
        : state.errorMessage
          ? state.errorMessage
          : formatProviderStatusSummary(
              state.providers.map((providerState) => providerState.record),
              state.localProviderIds,
            )
    );

  headerActions.addButton((button) => {
    button
      .setIcon("refresh-cw")
      .setTooltip("Refresh provider status")
      .setDisabled(state.loading || state.actionRunning)
      .onClick(async () => {
        button.setDisabled(true);
        await refreshProvidersAndModelHints(state, plugin, {
          forceModelRefresh: true,
        });
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
  const label = getProviderLabel(record.provider, state.oauthProvidersById);
  const localProvider = isStudioPiLocalProvider(record.provider);
  const displayState = getProviderDisplayState(record, state.localProviderIds);
  const connected = displayState.connected;
  const blocked = displayState.blocked;
  const localConfigured = hasConfiguredLocalProvider(record.provider, state.localProviderIds);
  const isExpanded =
    state.activeConnectProvider === record.provider;

  const row = listEl.createDiv({
    cls: `ss-provider-row ss-provider-row--${displayState.tone}`,
  });

  // ── Header ──
  const header = row.createDiv({ cls: "ss-provider-row__header" });

  const statusDot = header.createSpan({ cls: "ss-provider-row__status-dot" });
  statusDot.setAttribute("aria-label", displayState.statusLabel);

  const info = header.createDiv({ cls: "ss-provider-row__info" });
  info.createDiv({ cls: "ss-provider-row__name", text: label });
  info.createDiv({
    cls: "ss-provider-row__auth-summary",
    text: displayState.summary,
  });
  if (displayState.inlineReason) {
    const warningEl = info.createDiv({
      cls: "ss-provider-row__warning",
      text: displayState.inlineReason,
    });
    if (displayState.hoverDetails) {
      warningEl.title = displayState.hoverDetails;
    }
  }

  const actions = header.createDiv({ cls: "ss-provider-row__actions" });

  if (localProvider) {
    const setupBtn = actions.createEl("button", {
      cls: "ss-provider-row__btn ss-provider-row__btn--connect",
      text: isExpanded ? "Close" : localConfigured ? "Details" : "Set up",
    });
    setupBtn.disabled = state.actionRunning;
    setupBtn.addEventListener("click", () => {
      if (isExpanded) {
        state.activeConnectProvider = null;
        state.activeConnectMethod = null;
      } else {
        state.activeConnectProvider = record.provider;
        state.activeConnectMethod = null;
      }
      rerender();
    });
  } else if (blocked) {
    const fixBtn = actions.createEl("button", {
      cls: "ss-provider-row__btn ss-provider-row__btn--connect",
      text: isExpanded ? "Close" : "Fix",
    });
    fixBtn.disabled = state.actionRunning;
    fixBtn.addEventListener("click", () => {
      if (isExpanded) {
        state.activeConnectProvider = null;
        state.activeConnectMethod = null;
      } else {
        state.activeConnectProvider = record.provider;
        state.activeConnectMethod = resolveConnectMethod(
          record.provider,
          selectDefaultAuthMethod(record.provider, state.oauthProvidersById),
          state.oauthProvidersById
        );
      }
      rerender();
    });

    const disconnectBtn = actions.createEl("button", {
      cls: "ss-provider-row__btn ss-provider-row__btn--disconnect",
      text: "Disconnect",
    });
    disconnectBtn.disabled = state.actionRunning;
    disconnectBtn.addEventListener("click", () => {
      void performProviderDisconnect(state, plugin, record.provider, label, rerender);
    });
  } else if (connected) {
    const useInChatBtn = actions.createEl("button", {
      cls: "ss-provider-row__btn ss-provider-row__btn--connect",
      text: "Use in Chat",
    });
    useInChatBtn.disabled = state.actionRunning || localProvider;
    useInChatBtn.addEventListener("click", () => {
      void performUseProviderInChat(state, plugin, record.provider, label, rerender);
    });

    const disconnectBtn = actions.createEl("button", {
      cls: "ss-provider-row__btn ss-provider-row__btn--disconnect",
      text: "Disconnect",
    });
    disconnectBtn.disabled = state.actionRunning;
    disconnectBtn.addEventListener("click", () => {
      void performProviderDisconnect(state, plugin, record.provider, label, rerender);
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
        state.activeConnectMethod = resolveConnectMethod(
          record.provider,
          selectDefaultAuthMethod(record.provider, state.oauthProvidersById),
          state.oauthProvidersById
        );
      }
      rerender();
    });
  }

  if (connected && !localProvider) {
    const hint = state.providerModelHints.get(normalizeProviderId(record.provider));
    const readyEl = row.createDiv({ cls: "ss-provider-row__ready" });
    readyEl.createDiv({
      cls: "ss-provider-row__ready-text",
      text: getProviderReadyText(label, hint),
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
  const label = getProviderLabel(providerId, state.oauthProvidersById);
  if (isStudioPiLocalProvider(providerId)) {
    renderLocalProviderSetup(panel, state, providerId, label, plugin);
    return;
  }

  const hasOAuth = supportsOAuthLogin(providerId, state.oauthProvidersById);
  const envVar = getApiKeyEnvVarForProvider(providerId);
  const oauthRestriction = getStudioPiAuthMethodRestriction(providerId, "oauth");
  const apiKeyRestriction = getStudioPiAuthMethodRestriction(providerId, "api_key");
  const storedAuthRestriction = getStoredAuthRestriction(record);
  const resolvedConnectMethod = resolveConnectMethod(
    providerId,
    state.activeConnectMethod,
    state.oauthProvidersById
  );
  state.activeConnectMethod = resolvedConnectMethod;

  if (storedAuthRestriction) {
    const warningEl = panel.createDiv({
      cls: "ss-provider-connect-hint ss-provider-connect-hint--warning",
      text: storedAuthRestriction.inlineReason || `${label} subscription login is disabled here.`,
    });
    if (storedAuthRestriction.hoverDetails) {
      warningEl.title = storedAuthRestriction.hoverDetails;
    }
    panel.createDiv({
      cls: "ss-provider-connect-hint",
      text: "Save an API key to replace the stored subscription login, or disconnect it from the row above.",
    });
  }

  // Method tabs (if both are available)
  if (hasOAuth && envVar) {
    const methods = panel.createDiv({ cls: "ss-provider-connect-methods" });

    const oauthGroup = methods.createDiv({ cls: "ss-provider-connect-method-group" });
    const oauthBtn = oauthGroup.createEl("button", {
      cls: `ss-provider-connect-method ${resolvedConnectMethod === "oauth" ? "ss-provider-connect-method--active" : ""}`,
      text: "Subscription login",
    });
    oauthBtn.disabled = state.actionRunning || oauthRestriction.disabled;
    if (oauthRestriction.hoverDetails) {
      oauthBtn.title = oauthRestriction.hoverDetails;
    }
    if (!oauthRestriction.disabled) {
      oauthBtn.addEventListener("click", () => {
        state.activeConnectMethod = "oauth";
        rerender();
      });
    }
    if (oauthRestriction.disabled && oauthRestriction.inlineReason) {
      const reasonEl = oauthGroup.createDiv({
        cls: "ss-provider-connect-method-reason",
        text: oauthRestriction.inlineReason,
      });
      if (oauthRestriction.hoverDetails) {
        reasonEl.title = oauthRestriction.hoverDetails;
      }
    }

    const apiKeyGroup = methods.createDiv({ cls: "ss-provider-connect-method-group" });
    const apiKeyBtn = apiKeyGroup.createEl("button", {
      cls: `ss-provider-connect-method ${resolvedConnectMethod === "api_key" ? "ss-provider-connect-method--active" : ""}`,
      text: "API key",
    });
    apiKeyBtn.disabled = state.actionRunning || apiKeyRestriction.disabled;
    if (apiKeyRestriction.hoverDetails) {
      apiKeyBtn.title = apiKeyRestriction.hoverDetails;
    }
    if (!apiKeyRestriction.disabled) {
      apiKeyBtn.addEventListener("click", () => {
        state.activeConnectMethod = "api_key";
        rerender();
      });
    }
    if (apiKeyRestriction.disabled && apiKeyRestriction.inlineReason) {
      const reasonEl = apiKeyGroup.createDiv({
        cls: "ss-provider-connect-method-reason",
        text: apiKeyRestriction.inlineReason,
      });
      if (apiKeyRestriction.hoverDetails) {
        reasonEl.title = apiKeyRestriction.hoverDetails;
      }
    }
  } else {
    // Force the only available method
    state.activeConnectMethod = resolvedConnectMethod;
  }

  if (!resolvedConnectMethod) {
    const message =
      oauthRestriction.inlineReason ||
      apiKeyRestriction.inlineReason ||
      `No available connection method for ${label}.`;
    const blockedHint = panel.createDiv({
      cls: "ss-provider-connect-hint ss-provider-connect-hint--warning",
      text: message,
    });
    blockedHint.title =
      oauthRestriction.hoverDetails ||
      apiKeyRestriction.hoverDetails ||
      message;
    return;
  }

  if (resolvedConnectMethod === "oauth") {
    renderOAuthConnect(panel, tabInstance, state, providerId, label, rerender);
  } else {
    renderApiKeyConnect(panel, tabInstance, state, providerId, label, envVar, rerender);
  }
}

function renderLocalProviderSetup(
  panel: HTMLElement,
  state: TabState,
  providerId: string,
  label: string,
  plugin: SystemSculptSettingTab["plugin"],
): void {
  const body = panel.createDiv({ cls: "ss-provider-connect-body" });
  const setup = getStudioPiLocalProviderSetup(providerId, {
    modelsPath: getPiModelsDisplayPath(plugin),
  });
  const configured = hasConfiguredLocalProvider(providerId, state.localProviderIds);

  if (!setup) {
    body.createDiv({
      cls: "ss-provider-connect-hint ss-provider-connect-hint--warning",
      text: `No local setup instructions are available for ${label}.`,
    });
    return;
  }

  body.createDiv({
    cls: "ss-provider-connect-hint",
    text: configured
      ? `Pi already detects ${label} from ${setup.filePath}. Its local models should already appear in the model picker.`
      : `${label} is configured through ${setup.filePath}, not through subscription login or saved provider auth.`,
  });
  body.createDiv({
    cls: "ss-provider-connect-hint",
    text: setup.summary,
  });
  body.createDiv({
    cls: "ss-provider-connect-hint",
    text: `Use ${setup.endpoint} with ${setup.api}. Pi only needs model ids inside the models array.`,
  });
  body.createDiv({
    cls: "ss-provider-connect-hint",
    text: `Pi expects an apiKey field in the provider config. Use your real local server token if you have one; otherwise a placeholder like "${setup.apiKeyPlaceholder}" is fine for servers that ignore auth.`,
  });
  body.createDiv({
    cls: "ss-provider-connect-hint",
    text: configured
      ? "If you change models.json, press Refresh in this tab to rescan providers."
      : "Add or merge an entry like this into models.json, then press Refresh in this tab.",
  });

  const codeBlock = body.createEl("pre", { cls: "ss-provider-connect-code" });
  codeBlock.createEl("code", { text: setup.snippet });
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

    const modal = new OAuthStatusModal(plugin.app, label);
    modal.open();
    modal.showWaiting(() => abortController.abort());

    const usesCallbackServer = state.oauthProvidersById.get(
      normalizeProviderId(providerId)
    )?.usesCallbackServer ?? false;

    try {
      const { runStudioPiOAuthLoginFlow } = await loadStudioPiOAuthLoginFlowModule();
      await runStudioPiOAuthLoginFlow({
        providerId,
        plugin,
        onAuth: async (info) => {
          if (info.url) {
            await openExternalUrlForOAuth(info.url);
          }
        },
        onPrompt: async () => {
          return await modal.showPasteFallback();
        },
        onProgress: () => {},
        ...(usesCallbackServer
          ? {}
          : {
              onManualCodeInput: async () => {
                return await modal.showPasteFallback();
              },
            }),
        signal: abortController.signal,
      });

      await modal.showSuccess();
      state.activeConnectProvider = null;
      state.activeConnectMethod = null;
      await refreshProvidersAndModelHints(state, plugin, {
        forceModelRefresh: true,
        providerIds: [providerId],
      });
    } catch (error) {
      modal.close();
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
      const { setStudioPiProviderApiKey } = await loadStudioPiAuthStorageModule();
      await setStudioPiProviderApiKey(providerId, key, { plugin });
      state.activeConnectProvider = null;
      state.activeConnectMethod = null;
      await refreshProvidersAndModelHints(state, plugin, {
        forceModelRefresh: true,
        providerIds: [providerId],
      });
      const hint = state.providerModelHints.get(normalizeProviderId(providerId));
      new Notice(
        hint
          ? `${label} API key saved. ${hint.modelName} is ready in Chat.`
          : `${label} API key saved. Models will appear after refresh.`
      );
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
