import { App, Modal, Notice, Platform, setIcon } from "obsidian";
import type SystemSculptPlugin from "../../main";
import {
  buildStudioPiApiKeyEnvCommandHint,
  buildStudioPiResolvedLoginCommand,
  buildStudioPiLoginCommand,
  clearStudioPiProviderAuth,
  getStudioPiAuthStoragePathHintForPlatform,
  getStudioPiLoginSurfaceLabel,
  installStudioLocalPiCli,
  launchStudioPiProviderLoginInTerminal,
  listStudioPiOAuthProviders,
  readStudioPiProviderAuthState,
  setStudioPiProviderApiKey,
  type StudioPiAuthPrompt,
  type StudioPiOAuthProvider,
} from "../../studio/StudioLocalTextModelCatalog";
import { tryCopyToClipboard } from "../../utils/clipboard";
import { openExternalUrlForOAuth } from "../../utils/oauthUiHelpers";
import { runStudioPiOAuthLoginFlow } from "../../studio/piAuth/StudioPiOAuthLoginFlow";
import {
  buildApiKeyHint,
  getApiKeyEnvVarForProvider,
  getStudioPiRegisteredProviderIds,
  KNOWN_OAUTH_PROVIDER_IDS,
  resolveProviderLabel,
  selectDefaultAuthMethod,
  supportsOAuthLogin,
} from "../../studio/piAuth/StudioPiProviderRegistry";
import { listLocalPiProviderIds, listLocalPiTextModels } from "../../services/pi/PiTextModels";

export type StudioPiSetupWizardIssue =
  | "missing_cli"
  | "provider_auth"
  | "token_type"
  | "runtime_error";

export type StudioPiSetupWizardResult = {
  action: "dismiss" | "retry";
};

export type StudioPiSetupWizardOptions = {
  app: App;
  plugin: SystemSculptPlugin;
  issue: StudioPiSetupWizardIssue;
  modelId: string;
  provider: string;
  errorMessage: string;
  projectPath: string | null;
  onLog?: (label: string, details: Record<string, unknown>) => void;
};

type StepStatus = "idle" | "running" | "success" | "error";
type AuthMethod = "oauth" | "api_key";

type PendingPromptRequest = {
  message: string;
  placeholder?: string;
  allowEmpty: boolean;
  value: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

export function normalizeWizardProviderId(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[,:;!?]+$/g, "")
    .replace(/\.$/g, "");
}

function getPiLoginSurfaceLabel(): string {
  return getStudioPiLoginSurfaceLabel(process.platform);
}

// ─── Private helpers ────────────────────────────────────────────────────────

function normalizeEscapedNewlines(message: string): string {
  return String(message || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

function firstNonEmptyLine(message: string): string {
  const line = String(message || "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line || "Unknown error";
}

/**
 * Returns true when an error is a Pi CLI module-load failure (dynamic import of
 * auth-storage.js). These are expected in Obsidian's sandboxed renderer and should
 * not be surfaced as errors — the static known-OAuth provider list still works.
 */
function isPiModuleLoadError(message: string): boolean {
  return (
    message.includes("Failed to fetch") ||
    message.includes("dynamically imported module") ||
    message.includes("auth-storage.js")
  );
}

export class StudioPiSetupWizardModal extends Modal {
  private readonly plugin: SystemSculptPlugin;
  private readonly issue: StudioPiSetupWizardIssue;
  private readonly modelId: string;
  private readonly providerFromError: string;
  private readonly projectPath: string | null;
  private readonly errorMessage: string;
  private readonly onLog?: (label: string, details: Record<string, unknown>) => void;
  private readonly resolveResult: (result: StudioPiSetupWizardResult) => void;
  private resolved = false;
  private actionRunning = false;

  // Step statuses
  private cliStatus: StepStatus = "idle";
  private cliDetail = "Not checked yet.";
  private authStatus: StepStatus = "idle";
  private authDetail = "";
  private modelStatus: StepStatus = "idle";
  private modelDetail = "Not checked yet.";

  // Provider state
  private selectedProvider = "";
  private providerIds: string[] = [];
  private oauthProvidersById = new Map<string, StudioPiOAuthProvider>();
  private providerLoadError: string | null = null;
  private availableProviderIds: string[] = [];
  private availableModelCount = 0;

  // Auth state
  private authMethod: AuthMethod = "oauth";
  private pendingPrompt: PendingPromptRequest | null = null;
  private oauthAbortController: AbortController | null = null;
  private authUrl: string | null = null;
  private authInstructions: string | null = null;
  /**
   * False when loadPiAuthStorageModule() fails (Obsidian blocks file:// dynamic
   * imports). When false, in-modal OAuth and API-key save are unavailable — only
   * terminal-based flows work.
   */
  private inModalAuthAvailable = false;
  private apiKeyDraft = "";

  constructor(
    options: StudioPiSetupWizardOptions,
    resolveResult: (result: StudioPiSetupWizardResult) => void
  ) {
    super(options.app);
    this.plugin = options.plugin;
    this.issue = options.issue;
    this.modelId = String(options.modelId || "").trim();
    this.providerFromError = normalizeWizardProviderId(options.provider || "");
    this.selectedProvider = this.providerFromError;
    this.projectPath = options.projectPath;
    this.errorMessage = normalizeEscapedNewlines(options.errorMessage);
    this.onLog = options.onLog;
    this.resolveResult = resolveResult;

    if (this.issue === "provider_auth" || this.issue === "token_type") {
      this.authStatus = "error";
    }
    this.authDetail = this.initialAuthDetail();

    // Default auth method: oauth for token_type issues, otherwise oauth if available
    if (this.issue === "token_type") {
      this.authMethod = "oauth";
    }

    this.modalEl.addClass("ss-studio-pi-wizard-modal");
  }

  onOpen(): void {
    this.titleEl.setText("Set Up Pi");
    this.render();
    void this.initializeWizard();
  }

  onClose(): void {
    this.oauthAbortController?.abort();
    this.oauthAbortController = null;
    this.rejectPendingPrompt("Authentication cancelled.");
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolveResult({ action: "dismiss" });
    }
  }

  private async initializeWizard(): Promise<void> {
    await Promise.all([
      this.checkCliAvailability(),
      this.loadProviderMetadata(),
    ]);
  }

  private initialAuthDetail(): string {
    return "";
  }

  private log(label: string, details: Record<string, unknown>): void {
    if (this.onLog) {
      this.onLog(label, details);
      return;
    }
    console.error(label, details);
  }

  private setStepStatus(step: "cli" | "auth" | "model", status: StepStatus, detail: string): void {
    if (step === "cli") { this.cliStatus = status; this.cliDetail = detail; return; }
    if (step === "auth") { this.authStatus = status; this.authDetail = detail; return; }
    this.modelStatus = status;
    this.modelDetail = detail;
  }

  private statusLabel(status: StepStatus): string {
    if (status === "running") return "Running…";
    if (status === "success") return "Ready";
    if (status === "error") return "Needs attention";
    return "Pending";
  }

  private statusIcon(status: StepStatus): string {
    if (status === "running") return "loader";
    if (status === "success") return "check-circle";
    if (status === "error") return "alert-triangle";
    return "circle";
  }

  private providerLabel(providerId: string): string {
    return resolveProviderLabel(providerId, this.oauthProvidersById);
  }

  private authEnvVar(providerId: string): string {
    return getApiKeyEnvVarForProvider(providerId);
  }

  private supportsOAuth(providerId: string): boolean {
    return supportsOAuthLogin(providerId, this.oauthProvidersById);
  }

  private selectedProviderIsReady(): boolean {
    const provider = normalizeWizardProviderId(this.selectedProvider);
    return Boolean(provider) && this.availableProviderIds.includes(provider);
  }

  private syncSelectedProviderReadiness(): void {
    const provider = normalizeWizardProviderId(this.selectedProvider);
    if (!provider) {
      this.setStepStatus("model", "idle", "Choose a provider to continue.");
      return;
    }

    if (this.cliStatus !== "success") {
      this.setStepStatus("model", "idle", "Waiting for Pi to finish loading.");
      return;
    }

    if (this.selectedProviderIsReady()) {
      this.setStepStatus("auth", "success", `${this.providerActionLabel(provider)} is connected.`);
      this.setStepStatus("model", "success", `${this.providerActionLabel(provider)} is ready to use in Studio.`);
      return;
    }

    if (this.authStatus === "running") {
      this.setStepStatus("model", "idle", `Finish the ${this.providerActionLabel(provider)} login, then come back here.`);
      return;
    }

    if (this.authStatus === "success") {
      this.setStepStatus("model", "idle", `Checking ${this.providerActionLabel(provider)} in Pi.`);
      return;
    }

    this.setStepStatus("model", "idle", `${this.providerActionLabel(provider)} is not connected yet.`);
  }

  private canRetry(): boolean {
    if (this.cliStatus !== "success") return false;
    if (this.issue === "provider_auth" || this.issue === "token_type") {
      return this.selectedProviderIsReady();
    }
    return true;
  }

  private rejectPendingPrompt(message: string): void {
    if (!this.pendingPrompt) return;
    const request = this.pendingPrompt;
    this.pendingPrompt = null;
    request.reject(new Error(message));
  }

  private async runAction(label: string, action: () => Promise<void>): Promise<void> {
    if (this.actionRunning) return;
    this.actionRunning = true;
    this.render();
    try {
      await action();
    } catch (error) {
      const message = normalizeEscapedNewlines(
        error instanceof Error ? error.message : String(error || "")
      );
      this.log("[SystemSculpt Studio] Pi setup wizard action failed", {
        action: label,
        message,
        stack: error instanceof Error ? error.stack || null : null,
        issue: this.issue,
        modelId: this.modelId || null,
        provider: this.selectedProvider || null,
        projectPath: this.projectPath,
      });
      new Notice(`SystemSculpt Studio: ${firstNonEmptyLine(message)}`);
    } finally {
      this.actionRunning = false;
      this.render();
    }
  }

  private async checkCliAvailability(): Promise<void> {
    await this.runAction("check-cli", async () => {
      this.setStepStatus("cli", "running", "Studio is installing or checking Pi for you.");
      this.render();
      try {
        const result = await installStudioLocalPiCli(this.plugin);
        this.setStepStatus("cli", "success", `Pi ${result.version} is installed and ready.`);
        this.syncSelectedProviderReadiness();
      } catch (error) {
        const message = normalizeEscapedNewlines(
          error instanceof Error ? error.message : String(error || "")
        );
        this.setStepStatus("cli", "error", firstNonEmptyLine(message));
      }
    });
  }

  private async loadProviderMetadata(): Promise<void> {
    const providerSet = new Set<string>();
    if (this.providerFromError) providerSet.add(this.providerFromError);
    for (const id of getStudioPiRegisteredProviderIds()) providerSet.add(id);
    this.providerLoadError = null;

    try {
      const oauthProviders = await listStudioPiOAuthProviders();
      // Module loaded — in-modal OAuth and API-key save are available
      this.inModalAuthAvailable = true;
      this.oauthProvidersById = new Map(
        oauthProviders.map((p) => [normalizeWizardProviderId(p.id), p])
      );
      for (const p of oauthProviders) providerSet.add(normalizeWizardProviderId(p.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      if (isPiModuleLoadError(message)) {
        // Obsidian blocks file:// dynamic imports — in-modal auth is unavailable.
        // Terminal-based flows (pi /login) still work fine.
        this.inModalAuthAvailable = false;
      } else {
        this.inModalAuthAvailable = false;
        this.providerLoadError = firstNonEmptyLine(message);
      }
    }

    try {
      const availableProviders = await listLocalPiProviderIds(this.plugin);
      const availableModels = await listLocalPiTextModels(this.plugin);
      this.availableProviderIds = availableProviders;
      this.availableModelCount = availableModels.length;
      for (const id of availableProviders) providerSet.add(id);
    } catch {
      this.availableProviderIds = [];
      this.availableModelCount = 0;
    }

    this.providerIds = Array.from(providerSet.values()).sort((a, b) =>
      this.providerLabel(a).localeCompare(this.providerLabel(b))
    );
    const preferredDefaultProvider =
      (providerSet.has("openai-codex") ? "openai-codex" : "") ||
      this.providerIds[0] ||
      "";
    if (!this.selectedProvider || !providerSet.has(this.selectedProvider)) {
      this.selectedProvider = this.providerFromError || preferredDefaultProvider;
    }

    // Auto-select auth method based on provider capabilities
    const provider = normalizeWizardProviderId(this.selectedProvider);
    this.authMethod = selectDefaultAuthMethod(provider, this.oauthProvidersById);

    await this.refreshAuthStateDetail();
    this.syncSelectedProviderReadiness();
    this.render();
  }

  private async refreshAuthStateDetail(): Promise<void> {
    const provider = normalizeWizardProviderId(this.selectedProvider);
    if (!provider) {
      this.setStepStatus("auth", "idle", "");
      return;
    }
    try {
      const authState = await readStudioPiProviderAuthState(provider);
      const providerLabel = this.providerActionLabel(provider);
      const sourceText =
        authState.source === "oauth"
          ? `${providerLabel} is connected.`
          : authState.source === "api_key"
            ? `${providerLabel} is connected with an API key.`
            : authState.source === "environment_or_fallback"
              ? `${providerLabel} is connected from your environment.`
              : "";
      const status: StepStatus = authState.hasAnyAuth ? "success" : "idle";
      this.setStepStatus("auth", status, sourceText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      if (isPiModuleLoadError(message)) {
        this.setStepStatus("auth", "idle", "");
      } else {
        this.setStepStatus("auth", "error", firstNonEmptyLine(message));
      }
    }
  }

  private async refreshConnectionStatus(): Promise<void> {
    await this.runAction("refresh-connection-status", async () => {
      if (this.cliStatus !== "success") {
        this.setStepStatus("auth", "error", "Pi is still loading. Try again in a moment.");
        return;
      }
      const provider = normalizeWizardProviderId(this.selectedProvider);
      if (!provider) {
        this.setStepStatus("auth", "error", "Choose a provider first.");
        return;
      }
      this.setStepStatus("auth", "running", `Checking ${this.providerActionLabel(provider)}…`);
      this.syncSelectedProviderReadiness();
      this.render();
      await this.loadProviderMetadata();
      if (this.selectedProviderIsReady()) {
        new Notice(`${this.providerActionLabel(provider)} is ready in Pi.`);
      }
    });
  }

  private async openExternalUrl(url: string): Promise<void> {
    await openExternalUrlForOAuth(url);
  }

  private async requestAuthPrompt(prompt: StudioPiAuthPrompt): Promise<string> {
    this.rejectPendingPrompt("Authentication prompt replaced by a newer request.");
    const message = String(prompt?.message || "").trim() || "Enter value:";
    const placeholder = String(prompt?.placeholder || "").trim() || "";
    const allowEmpty = Boolean(prompt?.allowEmpty);
    return await new Promise<string>((resolve, reject) => {
      this.pendingPrompt = { message, placeholder, allowEmpty, value: "", resolve, reject };
      this.render();
    });
  }

  private submitPendingPrompt(): void {
    if (!this.pendingPrompt) return;
    const request = this.pendingPrompt;
    const value = String(request.value || "");
    if (!request.allowEmpty && !value.trim()) {
      new Notice("Input is required to continue authentication.");
      return;
    }
    this.pendingPrompt = null;
    request.resolve(value);
    this.render();
  }

  private cancelPendingPrompt(): void {
    this.rejectPendingPrompt("Authentication cancelled.");
    this.render();
  }

  private async startOAuthLoginInModal(): Promise<void> {
    await this.runAction("oauth-login-modal", async () => {
      if (this.cliStatus !== "success") {
        this.setStepStatus("auth", "error", "Verify the bundled Pi runtime first (Step 1).");
        return;
      }
      const provider = normalizeWizardProviderId(this.selectedProvider);
      if (!provider) {
        this.setStepStatus("auth", "error", "Select a provider first.");
        return;
      }
      if (!this.supportsOAuth(provider)) {
        this.setStepStatus("auth", "error", `"${provider}" doesn't support OAuth. Use API key instead.`);
        return;
      }
      // Pi auth-storage module is blocked in Obsidian's sandbox — fall back to terminal
      if (!this.inModalAuthAvailable) {
        await launchStudioPiProviderLoginInTerminal(this.plugin, provider);
        const loginSurface = getPiLoginSurfaceLabel();
        this.setStepStatus(
          "auth",
          "running",
          `Finish the ${this.providerActionLabel(provider)} login in ${loginSurface}, then come back here.`
        );
        this.syncSelectedProviderReadiness();
        new Notice(`Opened ${loginSurface} for Pi provider login.`);
        return;
      }

      this.oauthAbortController?.abort();
      const abortController = new AbortController();
      this.oauthAbortController = abortController;
      this.authUrl = null;
      this.authInstructions = null;
      this.setStepStatus("auth", "running", `Starting ${this.providerActionLabel(provider)} login…`);
      this.render();

      await runStudioPiOAuthLoginFlow({
        providerId: provider,
        onAuth: (info) => {
          this.authUrl = String(info.url || "").trim() || null;
          this.authInstructions = String(info.instructions || "").trim() || null;
          const detail = this.authInstructions || (this.authUrl ? `Authorize at the link below.` : "Continue OAuth flow.");
          this.setStepStatus("auth", "running", detail);
          if (this.authUrl) void this.openExternalUrl(this.authUrl);
          this.render();
        },
        onPrompt: async (prompt) => {
          return await this.requestAuthPrompt(prompt);
        },
        onProgress: (message) => {
          const detail = String(message || "").trim() || "Completing OAuth login…";
          this.setStepStatus("auth", "running", detail);
          this.render();
        },
        onManualCodeInput: async () => {
          return await this.requestAuthPrompt({
            message: "Paste the authorization code or full redirect URL:",
            placeholder: "https://…",
            allowEmpty: false,
          });
        },
        signal: abortController.signal,
      });

      this.oauthAbortController = null;
      this.pendingPrompt = null;
      this.authUrl = null;
      this.authInstructions = null;
      this.setStepStatus("auth", "success", `${this.providerActionLabel(provider)} login complete.`);
      new Notice(`Pi OAuth login complete for ${this.providerActionLabel(provider)}.`);
      await this.loadProviderMetadata();
    });
  }

  private cancelOAuthLogin(): void {
    if (this.oauthAbortController) {
      this.oauthAbortController.abort();
      this.oauthAbortController = null;
    }
    this.cancelPendingPrompt();
    this.authUrl = null;
    this.authInstructions = null;
    this.setStepStatus("auth", "idle", "OAuth login cancelled.");
    this.render();
  }

  private async saveApiKeyInModal(): Promise<void> {
    await this.runAction("save-api-key", async () => {
      if (this.cliStatus !== "success") {
        this.setStepStatus("auth", "error", "Verify the bundled Pi runtime first (Step 1).");
        return;
      }
      const provider = normalizeWizardProviderId(this.selectedProvider);
      if (!provider) {
        this.setStepStatus("auth", "error", "Select a provider first.");
        return;
      }
      if (!this.inModalAuthAvailable) {
        this.setStepStatus("auth", "error", "In-modal key save is unavailable — set the env var before launching Obsidian (see instructions above).");
        return;
      }
      const apiKey = String(this.apiKeyDraft || "").trim();
      if (!apiKey) {
        this.setStepStatus("auth", "error", "Enter an API key first.");
        return;
      }
      await setStudioPiProviderApiKey(provider, apiKey);
      this.apiKeyDraft = "";
      this.setStepStatus("auth", "success", `API key saved for ${this.providerLabel(provider)}.`);
      new Notice(`Saved Pi API key for ${this.providerLabel(provider)}.`);
      await this.loadProviderMetadata();
    });
  }

  private async clearProviderAuthInModal(): Promise<void> {
    await this.runAction("clear-provider-auth", async () => {
      const provider = normalizeWizardProviderId(this.selectedProvider);
      if (!provider) {
        this.setStepStatus("auth", "error", "Select a provider first.");
        return;
      }
      await clearStudioPiProviderAuth(provider);
      this.apiKeyDraft = "";
      this.setStepStatus("auth", "idle", `Cleared stored auth for ${this.providerLabel(provider)}.`);
      new Notice(`Cleared Pi auth for ${this.providerLabel(provider)}.`);
      await this.loadProviderMetadata();
    });
  }

  private async launchProviderLoginInTerminal(): Promise<void> {
    await this.runAction("launch-login-terminal", async () => {
      if (this.cliStatus !== "success") {
        this.setStepStatus("auth", "error", "Verify the bundled Pi runtime first (Step 1).");
        return;
      }
      const provider = normalizeWizardProviderId(this.selectedProvider);
      if (!provider) {
        this.setStepStatus("auth", "error", "Select a provider first.");
        return;
      }
      const loginCommand = await buildStudioPiResolvedLoginCommand(this.plugin, provider);
      this.setStepStatus("auth", "running", `Launching ${getPiLoginSurfaceLabel()}: ${loginCommand}…`);
      this.render();
      await launchStudioPiProviderLoginInTerminal(this.plugin, provider);
      const loginSurface = getPiLoginSurfaceLabel();
      this.setStepStatus(
        "auth",
        "running",
        `Finish the ${this.providerActionLabel(provider)} login in ${loginSurface}, then come back here.`
      );
      this.syncSelectedProviderReadiness();
      new Notice(`Opened ${loginSurface} for Pi provider login.`);
    });
  }

  private async copyLoginCommand(): Promise<void> {
    const provider = normalizeWizardProviderId(this.selectedProvider);
    let loginCommand = buildStudioPiLoginCommand(provider);
    if (Platform.isDesktopApp) {
      try {
        loginCommand = await buildStudioPiResolvedLoginCommand(this.plugin, provider);
      } catch {
        loginCommand = buildStudioPiLoginCommand(provider);
      }
    }
    const copied = await tryCopyToClipboard(loginCommand);
    new Notice(copied ? "Pi login command copied." : "Unable to copy Pi login command.");
  }

  private async copyAuthUrl(): Promise<void> {
    if (!this.authUrl) return;
    const copied = await tryCopyToClipboard(this.authUrl);
    new Notice(copied ? "Authorization URL copied." : "Unable to copy URL.");
  }

  private async verifyModels(): Promise<void> {
    await this.runAction("verify-models", async () => {
      if (this.cliStatus !== "success") {
        this.setStepStatus("model", "error", "Verify the bundled Pi runtime first (Step 1).");
        return;
      }
      this.setStepStatus("model", "running", "Loading Pi's available model catalog…");
      this.render();
      const models = await listLocalPiTextModels(this.plugin);
      const availableProviders = Array.from(
        new Set(
          models
            .map((model) => normalizeWizardProviderId(model.providerId))
            .filter(Boolean)
        )
      ).sort((left, right) => left.localeCompare(right));
      this.availableProviderIds = availableProviders;
      this.availableModelCount = models.length;
      const provider = normalizeWizardProviderId(this.selectedProvider);
      if (provider && !availableProviders.includes(provider)) {
        this.setStepStatus("model", "error", `"${this.providerLabel(provider)}" not listed yet. Complete auth and try again.`);
        return;
      }
      const providerCount = availableProviders.length;
      const providerLabel = provider ? this.providerLabel(provider) : "Pi";
      this.setStepStatus(
        "model",
        "success",
        `Loaded ${models.length} model${models.length === 1 ? "" : "s"} across ${providerCount} provider${providerCount === 1 ? "" : "s"} — "${providerLabel}" is available.`
      );
      if (this.issue === "provider_auth" || this.issue === "token_type") {
        this.setStepStatus("auth", "success", `Provider auth ready for ${this.providerLabel(provider)}.`);
      }
      await this.loadProviderMetadata();
    });
  }

  // ─── Render helpers ────────────────────────────────────────────────────────

  private renderStepHeader(
    container: HTMLElement,
    options: { index: number; title: string; description: string; status: StepStatus }
  ): void {
    const header = container.createDiv({ cls: "ss-pi-wizard__step-header" });

    const badge = header.createDiv({
      cls: `ss-pi-wizard__step-badge ss-pi-wizard__step-badge--${options.status}`,
      text: String(options.index),
    });
    void badge;

    const middle = header.createDiv({ cls: "ss-pi-wizard__step-meta" });
    middle.createDiv({ cls: "ss-pi-wizard__step-title", text: options.title });
    middle.createDiv({ cls: "ss-pi-wizard__step-description", text: options.description });

    const statusEl = header.createDiv({ cls: `ss-pi-wizard__step-status ss-pi-wizard__step-status--${options.status}` });
    const iconEl = statusEl.createSpan({ cls: "ss-pi-wizard__step-status-icon" });
    setIcon(iconEl, this.statusIcon(options.status));
    statusEl.createSpan({ cls: "ss-pi-wizard__step-status-label", text: this.statusLabel(options.status) });
  }

  private renderStepDetail(container: HTMLElement, text: string): void {
    if (!text) return;
    container.createDiv({ cls: "ss-pi-wizard__step-detail", text });
  }

  /** Providers filtered to those that support OAuth login. */
  private oauthProviderIds(): string[] {
    const all = this.providerIds.length > 0 ? this.providerIds : [this.selectedProvider].filter(Boolean);
    const oauthIds = all.filter((id) => this.supportsOAuth(id));
    // Always include the currently selected provider if it belongs here
    if (this.selectedProvider && this.supportsOAuth(this.selectedProvider) && !oauthIds.includes(this.selectedProvider)) {
      oauthIds.unshift(this.selectedProvider);
    }
    // Ensure at least the static known providers appear even before Pi loads
    for (const known of KNOWN_OAUTH_PROVIDER_IDS) {
      if (!oauthIds.includes(known)) oauthIds.push(known);
    }
    return oauthIds.sort((a, b) => this.providerLabel(a).localeCompare(this.providerLabel(b)));
  }

  /** Providers filtered to those with a known API-key env var (plus any in the full list). */
  private apiKeyProviderIds(): string[] {
    const all = this.providerIds.length > 0 ? this.providerIds : [this.selectedProvider].filter(Boolean);
    const ids = all.filter((id) => {
      return Boolean(this.authEnvVar(id)) || !this.supportsOAuth(id);
    });
    for (const id of getStudioPiRegisteredProviderIds()) {
      if (ids.includes(id)) {
        continue;
      }
      if (this.authEnvVar(id) || !this.supportsOAuth(id)) {
        ids.push(id);
      }
    }
    if (this.selectedProvider && !ids.includes(this.selectedProvider) && (this.authEnvVar(this.selectedProvider) || !this.supportsOAuth(this.selectedProvider))) {
      ids.unshift(this.selectedProvider);
    }
    return ids.sort((a, b) => this.providerLabel(a).localeCompare(this.providerLabel(b)));
  }

  /** Returns providers for the current auth method, switching selectedProvider if needed. */
  private providerIdsForCurrentMethod(): string[] {
    return this.authMethod === "oauth" ? this.oauthProviderIds() : this.apiKeyProviderIds();
  }

  private oauthChoiceIds(): string[] {
    const preferred = [
      "openai-codex",
      "anthropic",
      "google-antigravity",
      "google-gemini-cli",
      "github-copilot",
    ];
    const available = this.oauthProviderIds();
    const ordered: string[] = [];
    for (const id of preferred) {
      if (available.includes(id)) {
        ordered.push(id);
      }
    }
    if (this.selectedProvider && available.includes(this.selectedProvider) && !ordered.includes(this.selectedProvider)) {
      ordered.unshift(this.selectedProvider);
    }
    for (const id of available) {
      if (!ordered.includes(id)) {
        ordered.push(id);
      }
    }
    return ordered;
  }

  private oauthChoiceTitle(providerId: string): string {
    switch (normalizeWizardProviderId(providerId)) {
      case "openai-codex":
        return "ChatGPT subscription";
      case "anthropic":
        return "Claude subscription";
      case "google-antigravity":
        return "Google Antigravity subscription";
      case "google-gemini-cli":
        return "Google Gemini CLI subscription";
      case "github-copilot":
        return "GitHub Copilot subscription";
      default:
        return this.providerLabel(providerId);
    }
  }

  private oauthChoiceActionLabel(providerId: string): string {
    switch (normalizeWizardProviderId(providerId)) {
      case "openai-codex":
        return "ChatGPT";
      case "anthropic":
        return "Claude";
      case "google-antigravity":
        return "Google Antigravity";
      case "google-gemini-cli":
        return "Google Gemini CLI";
      case "github-copilot":
        return "GitHub Copilot";
      default:
        return this.providerLabel(providerId);
    }
  }

  private providerActionLabel(providerId: string): string {
    return this.supportsOAuth(providerId)
      ? this.oauthChoiceActionLabel(providerId)
      : this.providerLabel(providerId);
  }

  private oauthChoiceHint(providerId: string): string {
    switch (normalizeWizardProviderId(providerId)) {
      case "openai-codex":
        return "Use your ChatGPT subscription. Recommended for most people.";
      case "anthropic":
        return "Use your Claude subscription.";
      case "google-antigravity":
        return "Use your Google Antigravity subscription.";
      case "google-gemini-cli":
        return "Use your Google Gemini CLI subscription.";
      case "github-copilot":
        return "Use your GitHub Copilot subscription.";
      default:
        return `Use your ${this.providerLabel(providerId)} account.`;
    }
  }

  private authCardTitle(): string {
    if (this.selectedProviderIsReady()) {
      return `${this.providerActionLabel(this.selectedProvider)} is ready`;
    }
    return "How do you want to connect?";
  }

  private authCardDescription(): string {
    const provider = normalizeWizardProviderId(this.selectedProvider);
    const label = provider ? this.providerActionLabel(provider) : "your provider";
    if (this.selectedProviderIsReady()) {
      return "Everything is connected. Retry the Studio run when you're ready.";
    }
    if (this.issue === "token_type") {
      return `This model needs a ${label} subscription login instead of an API key.`;
    }
    return "Pick one way to add a provider to Pi. You can switch between subscription login and API key at any time.";
  }

  private hasTechnicalDetails(): boolean {
    if (String(this.providerLoadError || "").trim()) {
      return true;
    }
    if (this.cliStatus === "error" || this.modelStatus === "error") {
      return true;
    }
    if (this.issue === "runtime_error") {
      return true;
    }
    return this.issue === "missing_cli" && this.cliStatus !== "success";
  }

  private renderDisclosure(
    container: HTMLElement,
    summaryText: string,
    renderBody: (body: HTMLElement) => void
  ): void {
    const details = container.createEl("details", { cls: "ss-pi-wizard__details" });
    details.createEl("summary", { cls: "ss-pi-wizard__details-summary", text: summaryText });
    const body = details.createDiv({ cls: "ss-pi-wizard__details-body" });
    renderBody(body);
  }

  private renderCliStep(): void {
    const card = this.contentEl.createDiv({
      cls: `ss-pi-wizard__step ss-pi-wizard__step--${this.cliStatus}`,
    });
    this.renderStepHeader(card, {
      index: 1,
      title: "Install Pi",
      description: "Studio can install Pi automatically before you sign in.",
      status: this.cliStatus,
    });
    this.renderStepDetail(card, this.cliDetail);

    const actions = card.createDiv({ cls: "ss-pi-wizard__actions" });
    const checkBtn = actions.createEl("button", {
      cls: this.cliStatus !== "success" ? "mod-cta" : "",
      text: this.cliStatus === "running" ? "Installing Pi…" : "Install Pi",
    });
    checkBtn.disabled = this.actionRunning || this.cliStatus === "running";
    checkBtn.addEventListener("click", () => void this.checkCliAvailability());
  }

  private renderAuthStep(): void {
    const cardStatus: StepStatus = this.selectedProviderIsReady() ? "success" : this.authStatus;
    const card = this.contentEl.createDiv({
      cls: `ss-pi-wizard__step ss-pi-wizard__step--${cardStatus}`,
    });
    this.renderStepHeader(card, {
      index: this.cliStatus === "success" ? 1 : 2,
      title: this.authCardTitle(),
      description: this.authCardDescription(),
      status: cardStatus,
    });
    this.renderStepDetail(card, this.authDetail);

    this.renderConnectionMethodChoices(card);
    if (this.authMethod === "oauth") {
      this.renderOAuthSubscriptionChoices(card);
      this.renderOAuthPanel(card);
    } else {
      this.renderProviderSelector(card);
      this.renderApiKeyPanel(card);
    }
  }

  private renderConnectionMethodChoices(container: HTMLElement): void {
    const oauthIds = this.oauthProviderIds();
    const apiKeyIds = this.apiKeyProviderIds();
    const choices = container.createDiv({ cls: "ss-pi-wizard__method-list" });

    const oauthChoice = choices.createEl("button", {
      cls: `ss-pi-wizard__method-choice${this.authMethod === "oauth" ? " ss-pi-wizard__method-choice--active" : ""}`,
    });
    oauthChoice.disabled = this.actionRunning;
    const oauthText = oauthChoice.createDiv({ cls: "ss-pi-wizard__method-choice-text" });
    oauthText.createDiv({ cls: "ss-pi-wizard__method-choice-title", text: "Subscription login" });
    oauthText.createDiv({
      cls: "ss-pi-wizard__method-choice-hint",
      text: "Examples: ChatGPT, Claude, Google Antigravity, Gemini CLI, GitHub Copilot.",
    });
    const oauthIconEl = oauthChoice.createDiv({ cls: "ss-pi-wizard__method-choice-icon" });
    setIcon(oauthIconEl, "log-in");

    const apiKeyChoice = choices.createEl("button", {
      cls: `ss-pi-wizard__method-choice${this.authMethod === "api_key" ? " ss-pi-wizard__method-choice--active" : ""}`,
    });
    apiKeyChoice.disabled = this.actionRunning || this.issue === "token_type";
    const apiKeyText = apiKeyChoice.createDiv({ cls: "ss-pi-wizard__method-choice-text" });
    apiKeyText.createDiv({ cls: "ss-pi-wizard__method-choice-title", text: "API key" });
    apiKeyText.createDiv({
      cls: "ss-pi-wizard__method-choice-hint",
      text: "Examples: OpenAI, Anthropic, OpenRouter, Groq, Mistral.",
    });
    const keyIconEl = apiKeyChoice.createDiv({ cls: "ss-pi-wizard__method-choice-icon" });
    setIcon(keyIconEl, "key");

    oauthChoice.addEventListener("click", () => {
      if (this.authMethod === "oauth") return;
      this.authMethod = "oauth";
      if (!this.supportsOAuth(this.selectedProvider)) {
        this.selectedProvider = oauthIds[0] || this.selectedProvider;
        this.authUrl = null;
        this.authInstructions = null;
        this.apiKeyDraft = "";
        void this.refreshAuthStateDetail().then(() => {
          this.syncSelectedProviderReadiness();
          this.render();
        });
      }
      this.render();
    });

    apiKeyChoice.addEventListener("click", () => {
      if (this.authMethod === "api_key") return;
      this.authMethod = "api_key";
      if (!apiKeyIds.includes(this.selectedProvider)) {
        this.selectedProvider = this.providerFromError && apiKeyIds.includes(this.providerFromError)
          ? this.providerFromError
          : apiKeyIds[0] || this.selectedProvider;
      }
      this.authUrl = null;
      this.authInstructions = null;
      this.apiKeyDraft = "";
      void this.refreshAuthStateDetail().then(() => {
        this.syncSelectedProviderReadiness();
        this.render();
      });
    });
  }

  private renderProviderSelector(container: HTMLElement): void {
    const providerIds = this.providerIdsForCurrentMethod();
    const fallback = this.selectedProvider || this.providerFromError || "openai";
    const ids = providerIds.length > 0 ? providerIds : [fallback];

    // Ensure selectedProvider is valid for the current method; snap to first if not
    if (!ids.includes(this.selectedProvider) && ids.length > 0) {
      this.selectedProvider = ids[0];
      void this.refreshAuthStateDetail().then(() => {
        this.syncSelectedProviderReadiness();
        this.render();
      });
    }

    const row = container.createDiv({ cls: "ss-pi-wizard__provider-row" });
    const labelEl = row.createEl("label", { cls: "ss-pi-wizard__field-label", text: "Provider" });
    const selectId = "ss-pi-wizard-provider-select";
    labelEl.setAttribute("for", selectId);

    const select = row.createEl("select", { cls: "ss-pi-wizard__select" });
    select.id = selectId;
    for (const id of ids) {
      select.createEl("option", { value: id, text: this.providerLabel(id) });
    }
    select.value = this.selectedProvider || ids[0];
    select.disabled = this.actionRunning;
    select.addEventListener("change", () => {
      this.selectedProvider = normalizeWizardProviderId(select.value);
      this.authUrl = null;
      this.authInstructions = null;
      this.apiKeyDraft = "";
      void this.refreshAuthStateDetail().then(() => {
        this.syncSelectedProviderReadiness();
        this.render();
      });
    });
  }

  private renderOAuthSubscriptionChoices(container: HTMLElement): void {
    const choices = this.oauthChoiceIds();
    if (choices.length === 0) {
      return;
    }

    const list = container.createDiv({ cls: "ss-pi-wizard__oauth-choice-list" });
    for (const providerId of choices) {
      const selected = providerId === this.selectedProvider;
      const option = list.createEl("button", {
        cls: `ss-pi-wizard__oauth-choice${selected ? " ss-pi-wizard__oauth-choice--active" : ""}`,
      });
      option.disabled = this.actionRunning;
      option.addEventListener("click", () => {
        if (providerId === this.selectedProvider) {
          return;
        }
        this.selectedProvider = providerId;
        this.authUrl = null;
        this.authInstructions = null;
        this.apiKeyDraft = "";
        void this.refreshAuthStateDetail().then(() => {
          this.syncSelectedProviderReadiness();
          this.render();
        });
      });

      const text = option.createDiv({ cls: "ss-pi-wizard__oauth-choice-text" });
      text.createDiv({ cls: "ss-pi-wizard__oauth-choice-title", text: this.oauthChoiceTitle(providerId) });
      text.createDiv({ cls: "ss-pi-wizard__oauth-choice-hint", text: this.oauthChoiceHint(providerId) });
      if (selected) {
        const check = option.createDiv({ cls: "ss-pi-wizard__oauth-choice-check" });
        setIcon(check, "check");
      }
    }
  }

  private renderOAuthPanel(container: HTMLElement): void {
    const provider = normalizeWizardProviderId(this.selectedProvider);
    const panel = container.createDiv({ cls: "ss-pi-wizard__auth-panel" });
    const isOAuthRunning = this.oauthAbortController !== null;
    const isWaitingForExternalLogin = !this.inModalAuthAvailable && this.authStatus === "running";

    if (!isOAuthRunning) {
      if (!this.inModalAuthAvailable) {
        const loginSurface = getPiLoginSurfaceLabel();
        panel.createDiv({
          cls: "ss-pi-wizard__sandbox-notice",
          text: isWaitingForExternalLogin
            ? `Finish the ${this.oauthChoiceActionLabel(provider)} login in ${loginSurface}, then come back here.`
            : `We’ll open ${loginSurface} and continue the ${this.oauthChoiceActionLabel(provider)} login for you.`,
        });
      }

      const loginBtn = panel.createEl("button", {
        cls: "mod-cta ss-pi-wizard__oauth-login-btn",
        text: isWaitingForExternalLogin
          ? `I Finished in ${getPiLoginSurfaceLabel()}`
          : `Continue with ${this.oauthChoiceActionLabel(provider)}`,
      });
      loginBtn.disabled = this.actionRunning || this.cliStatus !== "success";
      loginBtn.addEventListener("click", () => {
        if (isWaitingForExternalLogin) {
          void this.refreshConnectionStatus();
          return;
        }
        void this.startOAuthLoginInModal();
      });

      if (this.inModalAuthAvailable) {
        panel.createDiv({
          cls: "ss-pi-wizard__hint",
          text: `Studio will open the ${this.oauthChoiceActionLabel(provider)} login for you.`,
        });
      }

      this.renderDisclosure(panel, "Other ways to connect", (body) => {
        const actions = body.createDiv({ cls: "ss-pi-wizard__actions ss-pi-wizard__actions--secondary" });
        if (this.inModalAuthAvailable) {
          const terminalBtn = actions.createEl("button", { text: `Open in ${getPiLoginSurfaceLabel()}` });
          terminalBtn.disabled = this.actionRunning || this.cliStatus !== "success";
          terminalBtn.addEventListener("click", () => void this.launchProviderLoginInTerminal());
        }
        const copyBtn = actions.createEl("button", { text: "Copy Login Command" });
        copyBtn.disabled = this.actionRunning;
        copyBtn.addEventListener("click", () => void this.copyLoginCommand());
      });
    } else {
      // OAuth in progress (only reachable when inModalAuthAvailable = true)
      const progress = panel.createDiv({ cls: "ss-pi-wizard__oauth-progress" });
      const spinner = progress.createDiv({ cls: "ss-pi-wizard__oauth-spinner" });
      setIcon(spinner, "loader");
      progress.createDiv({ cls: "ss-pi-wizard__oauth-progress-text", text: this.authDetail || "OAuth login in progress…" });

      if (this.authUrl) {
        const urlCard = panel.createDiv({ cls: "ss-pi-wizard__url-card" });
        urlCard.createDiv({ cls: "ss-pi-wizard__field-label", text: "Authorization URL" });
        const link = urlCard.createEl("a", { cls: "ss-pi-wizard__auth-url", text: this.authUrl });
        link.href = this.authUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        if (this.authInstructions) {
          urlCard.createDiv({ cls: "ss-pi-wizard__hint", text: this.authInstructions });
        }
        const urlActions = urlCard.createDiv({ cls: "ss-pi-wizard__actions" });
        const openBtn = urlActions.createEl("button", { cls: "mod-cta", text: "Open URL" });
        openBtn.addEventListener("click", () => void this.openExternalUrl(this.authUrl || ""));
        const copyUrlBtn = urlActions.createEl("button", { text: "Copy URL" });
        copyUrlBtn.addEventListener("click", () => void this.copyAuthUrl());
      }

      if (this.pendingPrompt) this.renderPromptInput(panel);

      const cancelBtn = panel.createEl("button", {
        cls: "ss-pi-wizard__cancel-oauth",
        text: "Cancel OAuth Login",
      });
      cancelBtn.addEventListener("click", () => this.cancelOAuthLogin());
    }
  }

  private renderApiKeyPanel(container: HTMLElement): void {
    const provider = normalizeWizardProviderId(this.selectedProvider);
    const envVar = this.authEnvVar(provider);
    const panel = container.createDiv({ cls: "ss-pi-wizard__auth-panel" });

    if (!this.inModalAuthAvailable) {
      const loginSurface = getPiLoginSurfaceLabel();
      panel.createDiv({
        cls: "ss-pi-wizard__sandbox-notice",
        text: `Set your ${this.providerLabel(provider)} API key in ${loginSurface}, then reopen Obsidian.`,
      });
      if (envVar) {
        const cmd = buildStudioPiApiKeyEnvCommandHint(envVar, process.platform);
        const cmdRow = panel.createDiv({ cls: "ss-pi-wizard__cmd-row" });
        cmdRow.createEl("code", { cls: "ss-pi-wizard__cmd-code", text: cmd });
        const copyCmd = cmdRow.createEl("button", { text: "Copy" });
        copyCmd.addEventListener("click", async () => {
          const copied = await tryCopyToClipboard(cmd);
          new Notice(copied ? "Command copied." : "Unable to copy.");
        });
      }
      this.renderDisclosure(panel, "Alternative manual setup", (body) => {
        body.createDiv({
          cls: "ss-pi-wizard__hint",
          text: `You can also add your key to ${getStudioPiAuthStoragePathHintForPlatform(process.platform)} and then reopen Obsidian.`,
        });
      });
      return;
    }

    panel.createDiv({
      cls: "ss-pi-wizard__hint",
      text: envVar ? `Paste your ${this.providerLabel(provider)} key. We’ll save it for future runs.` : buildApiKeyHint(provider, envVar || undefined),
    });

    const fieldLabel = panel.createEl("label", {
      cls: "ss-pi-wizard__field-label",
      text: envVar ? `API Key  ·  ${envVar}` : "API Key",
    });
    const inputId = "ss-pi-wizard-api-key-input";
    fieldLabel.setAttribute("for", inputId);

    const input = panel.createEl("input", {
      cls: "ss-pi-wizard__input",
      type: "password",
      placeholder: "Paste your API key here",
    });
    input.id = inputId;
    input.value = this.apiKeyDraft;
    input.disabled = this.actionRunning || !provider;
    input.addEventListener("input", () => { this.apiKeyDraft = input.value; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); void this.saveApiKeyInModal(); }
    });

    const actions = panel.createDiv({ cls: "ss-pi-wizard__actions" });
    const saveBtn = actions.createEl("button", { cls: "mod-cta", text: "Save and Continue" });
    saveBtn.disabled = this.actionRunning || !provider;
    saveBtn.addEventListener("click", () => void this.saveApiKeyInModal());

    const clearBtn = actions.createEl("button", { text: "Clear Stored Auth" });
    clearBtn.disabled = this.actionRunning || !provider;
    clearBtn.addEventListener("click", () => void this.clearProviderAuthInModal());
  }

  private renderPromptInput(container: HTMLElement): void {
    if (!this.pendingPrompt) return;
    const promptCard = container.createDiv({ cls: "ss-pi-wizard__prompt-card" });
    promptCard.createDiv({ cls: "ss-pi-wizard__field-label", text: this.pendingPrompt.message });

    const input = promptCard.createEl("input", {
      cls: "ss-pi-wizard__input",
      type: "text",
      placeholder: this.pendingPrompt.placeholder || "",
    });
    input.value = this.pendingPrompt.value;
    input.addEventListener("input", () => {
      if (this.pendingPrompt) this.pendingPrompt.value = input.value;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.submitPendingPrompt(); }
    });
    setTimeout(() => input.focus(), 0);

    const actions = promptCard.createDiv({ cls: "ss-pi-wizard__actions" });
    const submitBtn = actions.createEl("button", { cls: "mod-cta", text: "Submit" });
    submitBtn.addEventListener("click", () => this.submitPendingPrompt());
    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.cancelPendingPrompt());
  }

  private renderModelStep(): void {
    const card = this.contentEl.createDiv({
      cls: `ss-pi-wizard__step ss-pi-wizard__step--${this.modelStatus}`,
    });
    this.renderStepHeader(card, {
      index: this.cliStatus === "success" ? 2 : 3,
      title: "Verify models",
      description: "Confirms that your provider's models are accessible after auth.",
      status: this.modelStatus,
    });
    this.renderStepDetail(card, this.modelDetail);

    if (this.availableModelCount > 0 || this.availableProviderIds.length > 0) {
      const count = this.availableProviderIds.length;
      card.createDiv({
        cls: "ss-pi-wizard__hint",
        text: `${count} provider${count !== 1 ? "s" : ""} currently available in Pi.`,
      });
    }

    const actions = card.createDiv({ cls: "ss-pi-wizard__actions" });
    const verifyBtn = actions.createEl("button", { cls: "mod-cta", text: "Verify Models" });
    verifyBtn.disabled = this.actionRunning || this.cliStatus !== "success";
    verifyBtn.addEventListener("click", () => void this.verifyModels());
  }

  private render(): void {
    this.contentEl.empty();
    if (this.cliStatus !== "success") {
      this.renderCliStep();
    }
    if (this.cliStatus === "success" || this.issue !== "missing_cli") {
      this.renderAuthStep();
    }
    if (this.cliStatus === "success" && this.modelStatus === "error") {
      this.renderModelStep();
    }

    if (this.hasTechnicalDetails()) {
      const technicalDetailText = [
        this.providerLoadError ? `Provider metadata: ${this.providerLoadError}` : "",
        this.errorMessage,
      ]
        .filter((value) => String(value || "").trim().length > 0)
        .join("\n\n");
      if (technicalDetailText) {
        const details = this.contentEl.createEl("details", { cls: "ss-pi-wizard__error-details" });
        details.createEl("summary", { text: "Show technical details" });
        details.createEl("pre", { cls: "ss-pi-wizard__error-pre", text: technicalDetailText });
      }
    }

    const footer = this.contentEl.createDiv({ cls: "ss-pi-wizard__footer" });
    const closeBtn = footer.createEl("button", { text: "Not Now" });
    closeBtn.disabled = this.actionRunning;
    closeBtn.addEventListener("click", () => this.close());

    const retryBtn = footer.createEl("button", {
      cls: "mod-cta",
      text: this.selectedProviderIsReady() ? "Retry Studio Run" : "Retry When Ready",
    });
    retryBtn.disabled = this.actionRunning || !this.canRetry();
    retryBtn.addEventListener("click", () => {
      if (this.resolved) return;
      this.resolved = true;
      this.resolveResult({ action: "retry" });
      this.close();
    });
  }
}

export async function openStudioPiSetupWizard(
  options: StudioPiSetupWizardOptions
): Promise<StudioPiSetupWizardResult> {
  return await new Promise<StudioPiSetupWizardResult>((resolve) => {
    const modal = new StudioPiSetupWizardModal(options, resolve);
    modal.open();
  });
}
