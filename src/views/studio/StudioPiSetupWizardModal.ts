import { App, Modal, Notice, setIcon } from "obsidian";
import type SystemSculptPlugin from "../../main";
import {
  buildStudioPiLoginCommand,
  clearStudioPiProviderAuth,
  installStudioLocalPiCli,
  launchStudioPiProviderLoginInTerminal,
  listStudioPiOAuthProviders,
  readStudioPiProviderAuthState,
  runStudioPiCommand,
  setStudioPiProviderApiKey,
  type PiCommandResult,
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
  parseProviderIdsFromModelList,
  providerIsListedByPiModelList,
  resolveProviderLabel,
  selectDefaultAuthMethod,
  supportsOAuthLogin,
} from "../../studio/piAuth/StudioPiProviderRegistry";

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
  return String(value || "").trim().toLowerCase();
}

// ─── Private helpers ────────────────────────────────────────────────────────

function normalizeEscapedNewlines(message: string): string {
  return String(message || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

function summarizePiCommandResult(result: PiCommandResult): string {
  const stderr = String(result.stderr || "").trim();
  if (stderr) {
    const line = stderr
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    if (line) return line;
  }
  const stdout = String(result.stdout || "").trim();
  if (stdout) {
    const line = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    if (line) return line;
  }
  return `pi exited with code ${result.exitCode}.`;
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

function parsePiVersion(stdout: string): string {
  return (
    String(stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) || "unknown"
  );
}

class StudioPiSetupWizardModal extends Modal {
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
  private latestModelListStdout = "";

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
    this.titleEl.setText("Local (Pi) Setup");
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
    const provider = this.selectedProvider || "<provider>";
    if (this.issue === "provider_auth" || this.issue === "token_type") {
      return `Provider "${provider}" needs authentication.`;
    }
    return "Select a provider and authenticate if needed.";
  }

  private issueHeading(): string {
    switch (this.issue) {
      case "missing_cli":
        return "Pi CLI not found";
      case "provider_auth":
        return "Provider authentication required";
      case "token_type":
        return "Wrong token type for this model";
      default:
        return "Local (Pi) runtime issue";
    }
  }

  private issueHint(): string {
    switch (this.issue) {
      case "missing_cli":
        return "Install the Pi CLI below, then authenticate your provider and retry.";
      case "provider_auth":
        return "Choose OAuth or API key in Step 2, verify models, then retry.";
      case "token_type":
        return "This model requires OAuth credentials. Use OAuth login in Step 2.";
      default:
        return "Follow the steps below to diagnose and recover.";
    }
  }

  private issueVariant(): "info" | "warn" | "error" {
    if (this.issue === "missing_cli") return "warn";
    if (this.issue === "provider_auth" || this.issue === "token_type") return "error";
    return "error";
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

  private canRetry(): boolean {
    if (this.cliStatus !== "success") return false;
    if (this.issue === "provider_auth" || this.issue === "token_type") {
      return this.modelStatus === "success" || this.authStatus === "success";
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
      this.setStepStatus("cli", "running", "Checking pi --version…");
      this.render();
      try {
        const result = await runStudioPiCommand(this.plugin, ["--version"], 30_000);
        if (result.timedOut) {
          this.setStepStatus("cli", "error", "Timed out while checking pi --version.");
          return;
        }
        if (result.exitCode !== 0) {
          this.setStepStatus("cli", "error", summarizePiCommandResult(result));
          return;
        }
        const version = parsePiVersion(result.stdout);
        this.setStepStatus("cli", "success", `Pi ${version} detected and ready.`);
      } catch (error) {
        const message = normalizeEscapedNewlines(
          error instanceof Error ? error.message : String(error || "")
        );
        this.setStepStatus("cli", "error", firstNonEmptyLine(message));
      }
    });
  }

  private async installCli(): Promise<void> {
    await this.runAction("install-cli", async () => {
      this.setStepStatus("cli", "running", "Installing @mariozechner/pi-coding-agent…");
      this.render();
      const result = await installStudioLocalPiCli(this.plugin);
      this.setStepStatus("cli", "success", `Pi ${result.version} installed.`);
      new Notice(`Local (Pi) CLI installed (${result.version}).`);
      await this.loadProviderMetadata();
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
      const listResult = await runStudioPiCommand(this.plugin, ["--list-models"], 60_000);
      if (!listResult.timedOut && listResult.exitCode === 0) {
        this.latestModelListStdout = String(listResult.stdout || "");
        for (const id of parseProviderIdsFromModelList(listResult.stdout)) providerSet.add(id);
      }
    } catch {
      // Best-effort
    }

    this.providerIds = Array.from(providerSet.values()).sort((a, b) =>
      this.providerLabel(a).localeCompare(this.providerLabel(b))
    );
    if (!this.selectedProvider || !providerSet.has(this.selectedProvider)) {
      this.selectedProvider = this.providerFromError || this.providerIds[0] || "";
    }

    // Auto-select auth method based on provider capabilities
    const provider = normalizeWizardProviderId(this.selectedProvider);
    this.authMethod = selectDefaultAuthMethod(provider, this.oauthProvidersById);

    await this.refreshAuthStateDetail();
    this.render();
  }

  private async refreshAuthStateDetail(): Promise<void> {
    const provider = normalizeWizardProviderId(this.selectedProvider);
    if (!provider) {
      this.setStepStatus("auth", "idle", "Select a provider to configure authentication.");
      return;
    }
    try {
      const authState = await readStudioPiProviderAuthState(provider);
      const sourceText =
        authState.source === "oauth"
          ? "OAuth token stored in auth.json."
          : authState.source === "api_key"
            ? "API key stored in auth.json."
            : authState.source === "environment_or_fallback"
              ? "Credentials found in environment."
              : "No credentials found.";
      const status: StepStatus = authState.hasAnyAuth ? "success" : "idle";
      this.setStepStatus("auth", status, sourceText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      if (isPiModuleLoadError(message)) {
        // Can't load Pi auth-storage in Obsidian's sandbox — treat as no credentials
        // detected rather than a hard error. Auth flow can still proceed.
        this.setStepStatus("auth", "idle", "Auth state unavailable until Pi CLI is authenticated.");
      } else {
        this.setStepStatus("auth", "error", firstNonEmptyLine(message));
      }
    }
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
        this.setStepStatus("auth", "error", "Install or verify Pi CLI first (Step 1).");
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
        this.setStepStatus("auth", "success", `Terminal opened for ${this.providerLabel(provider)}. Complete login, then verify models.`);
        new Notice("Opened Terminal for Pi provider login.");
        return;
      }

      this.oauthAbortController?.abort();
      const abortController = new AbortController();
      this.oauthAbortController = abortController;
      this.authUrl = null;
      this.authInstructions = null;
      this.setStepStatus("auth", "running", `Starting OAuth login for ${this.providerLabel(provider)}…`);
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
      this.setStepStatus("auth", "success", `OAuth login complete for ${this.providerLabel(provider)}.`);
      new Notice(`Pi OAuth login complete for ${this.providerLabel(provider)}.`);
      await this.refreshAuthStateDetail();
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
        this.setStepStatus("auth", "error", "Install or verify Pi CLI first (Step 1).");
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
      await this.refreshAuthStateDetail();
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
      await this.refreshAuthStateDetail();
    });
  }

  private async launchProviderLoginInTerminal(): Promise<void> {
    await this.runAction("launch-login-terminal", async () => {
      if (this.cliStatus !== "success") {
        this.setStepStatus("auth", "error", "Install or verify Pi CLI first (Step 1).");
        return;
      }
      const provider = normalizeWizardProviderId(this.selectedProvider);
      if (!provider) {
        this.setStepStatus("auth", "error", "Select a provider first.");
        return;
      }
      const loginCommand = buildStudioPiLoginCommand(provider);
      this.setStepStatus("auth", "running", `Launching Terminal: ${loginCommand}…`);
      this.render();
      await launchStudioPiProviderLoginInTerminal(this.plugin, provider);
      this.setStepStatus("auth", "success", `Terminal opened for ${this.providerLabel(provider)}. Complete login and verify models.`);
      new Notice("Opened Terminal for Pi provider login.");
    });
  }

  private async copyLoginCommand(): Promise<void> {
    const provider = normalizeWizardProviderId(this.selectedProvider);
    const loginCommand = buildStudioPiLoginCommand(provider);
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
        this.setStepStatus("model", "error", "Install or verify Pi CLI first (Step 1).");
        return;
      }
      this.setStepStatus("model", "running", "Running pi --list-models…");
      this.render();
      const result = await runStudioPiCommand(this.plugin, ["--list-models"], 60_000);
      if (result.timedOut) {
        this.setStepStatus("model", "error", "Timed out while loading models.");
        return;
      }
      if (result.exitCode !== 0) {
        this.setStepStatus("model", "error", summarizePiCommandResult(result));
        return;
      }
      this.latestModelListStdout = String(result.stdout || "");
      const provider = normalizeWizardProviderId(this.selectedProvider);
      if (!providerIsListedByPiModelList(result.stdout, provider)) {
        this.setStepStatus("model", "error", `"${this.providerLabel(provider)}" not listed yet. Complete auth and try again.`);
        return;
      }
      this.setStepStatus("model", "success", `Models loaded — "${this.providerLabel(provider)}" is available.`);
      if (this.issue === "provider_auth" || this.issue === "token_type") {
        this.setStepStatus("auth", "success", `Provider auth ready for ${this.providerLabel(provider)}.`);
      }
      await this.loadProviderMetadata();
    });
  }

  // ─── Render helpers ────────────────────────────────────────────────────────

  private renderBanner(): void {
    const variant = this.issueVariant();
    const banner = this.contentEl.createDiv({ cls: `ss-pi-wizard__banner ss-pi-wizard__banner--${variant}` });

    const iconEl = banner.createDiv({ cls: "ss-pi-wizard__banner-icon" });
    setIcon(iconEl, variant === "warn" ? "alert-circle" : "alert-triangle");

    const body = banner.createDiv({ cls: "ss-pi-wizard__banner-body" });
    body.createDiv({ cls: "ss-pi-wizard__banner-heading", text: this.issueHeading() });
    body.createDiv({ cls: "ss-pi-wizard__banner-hint", text: this.issueHint() });

    if (this.modelId || this.projectPath) {
      const meta = body.createDiv({ cls: "ss-pi-wizard__banner-meta" });
      if (this.modelId) {
        const chip = meta.createDiv({ cls: "ss-pi-wizard__meta-chip" });
        chip.createSpan({ cls: "ss-pi-wizard__meta-chip-label", text: "Model" });
        chip.createSpan({ cls: "ss-pi-wizard__meta-chip-value", text: this.modelId });
      }
      if (this.projectPath) {
        const chip = meta.createDiv({ cls: "ss-pi-wizard__meta-chip" });
        chip.createSpan({ cls: "ss-pi-wizard__meta-chip-label", text: "Project" });
        chip.createSpan({ cls: "ss-pi-wizard__meta-chip-value", text: this.projectPath });
      }
    }
  }

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
    // Show all providers under API key — every provider may accept a key
    const ids = [...all];
    // Ensure providers with known env vars are present even if not yet discovered
    for (const id of getStudioPiRegisteredProviderIds()) {
      if (!ids.includes(id)) ids.push(id);
    }
    return ids.sort((a, b) => this.providerLabel(a).localeCompare(this.providerLabel(b)));
  }

  /** Returns providers for the current auth method, switching selectedProvider if needed. */
  private providerIdsForCurrentMethod(): string[] {
    return this.authMethod === "oauth" ? this.oauthProviderIds() : this.apiKeyProviderIds();
  }

  private renderCliStep(): void {
    const card = this.contentEl.createDiv({
      cls: `ss-pi-wizard__step ss-pi-wizard__step--${this.cliStatus}`,
    });
    this.renderStepHeader(card, {
      index: 1,
      title: "Install & verify Pi CLI",
      description: "Studio needs a working pi binary accessible in the desktop runtime.",
      status: this.cliStatus,
    });
    this.renderStepDetail(card, this.cliDetail);

    const actions = card.createDiv({ cls: "ss-pi-wizard__actions" });
    const checkBtn = actions.createEl("button", { text: "Check CLI" });
    checkBtn.disabled = this.actionRunning;
    checkBtn.addEventListener("click", () => void this.checkCliAvailability());

    const installBtn = actions.createEl("button", {
      cls: this.cliStatus !== "success" ? "mod-cta" : "",
      text: "Install CLI",
    });
    installBtn.disabled = this.actionRunning || this.cliStatus === "success";
    installBtn.addEventListener("click", () => void this.installCli());
  }

  private renderAuthStep(): void {
    const card = this.contentEl.createDiv({
      cls: `ss-pi-wizard__step ss-pi-wizard__step--${this.authStatus}`,
    });
    this.renderStepHeader(card, {
      index: 2,
      title: "Authenticate provider",
      description: "Pick an auth method, choose your provider, then authenticate.",
      status: this.authStatus,
    });
    this.renderStepDetail(card, this.authDetail);

    // 1. Auth method tabs — always first
    this.renderAuthMethodTabs(card);

    // 2. Provider dropdown — filtered to the selected method
    this.renderProviderSelector(card);

    // 3. Auth action — panel for the selected method
    if (this.authMethod === "oauth") {
      this.renderOAuthPanel(card);
    } else {
      this.renderApiKeyPanel(card);
    }
  }

  private renderAuthMethodTabs(container: HTMLElement): void {
    const oauthIds = this.oauthProviderIds();
    const hasOAuthProviders = oauthIds.length > 0;

    const tabs = container.createDiv({ cls: "ss-pi-wizard__auth-tabs" });

    const oauthTab = tabs.createEl("button", {
      cls: `ss-pi-wizard__auth-tab${this.authMethod === "oauth" ? " ss-pi-wizard__auth-tab--active" : ""}`,
    });
    const oauthIconEl = oauthTab.createSpan({ cls: "ss-pi-wizard__tab-icon" });
    setIcon(oauthIconEl, "log-in");
    oauthTab.createSpan({ text: "OAuth Login" });

    const apiKeyTab = tabs.createEl("button", {
      cls: `ss-pi-wizard__auth-tab${this.authMethod === "api_key" ? " ss-pi-wizard__auth-tab--active" : ""}`,
    });
    const keyIconEl = apiKeyTab.createSpan({ cls: "ss-pi-wizard__tab-icon" });
    setIcon(keyIconEl, "key");
    apiKeyTab.createSpan({ text: "API Key" });

    oauthTab.addEventListener("click", () => {
      if (this.authMethod === "oauth") return;
      this.authMethod = "oauth";
      // If current provider isn't an OAuth provider, switch to the first one
      if (!this.supportsOAuth(this.selectedProvider)) {
        this.selectedProvider = oauthIds[0] || this.selectedProvider;
        this.authUrl = null;
        this.authInstructions = null;
        this.apiKeyDraft = "";
        void this.refreshAuthStateDetail();
      }
      this.render();
    });

    apiKeyTab.addEventListener("click", () => {
      if (this.authMethod === "api_key") return;
      this.authMethod = "api_key";
      this.authUrl = null;
      this.authInstructions = null;
      this.render();
    });

    void hasOAuthProviders; // suppress unused warning; used implicitly via oauthIds
  }

  private renderProviderSelector(container: HTMLElement): void {
    const providerIds = this.providerIdsForCurrentMethod();
    const fallback = this.selectedProvider || this.providerFromError || "openai";
    const ids = providerIds.length > 0 ? providerIds : [fallback];

    // Ensure selectedProvider is valid for the current method; snap to first if not
    if (!ids.includes(this.selectedProvider) && ids.length > 0) {
      this.selectedProvider = ids[0];
      void this.refreshAuthStateDetail();
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
      void this.refreshAuthStateDetail();
      this.render();
    });

    if (this.providerLoadError) {
      container.createDiv({
        cls: "ss-pi-wizard__hint ss-pi-wizard__hint--warn",
        text: `Provider list warning: ${this.providerLoadError}`,
      });
    }
  }

  private renderOAuthPanel(container: HTMLElement): void {
    const provider = normalizeWizardProviderId(this.selectedProvider);
    const panel = container.createDiv({ cls: "ss-pi-wizard__auth-panel" });
    const isOAuthRunning = this.oauthAbortController !== null;

    if (!isOAuthRunning) {
      if (!this.inModalAuthAvailable) {
        // Obsidian blocks file:// dynamic imports, so in-modal OAuth is unavailable.
        // Terminal is the only path — make it the obvious primary action.
        panel.createDiv({
          cls: "ss-pi-wizard__sandbox-notice",
          text: "Obsidian's sandbox prevents in-app OAuth. Use Terminal to complete the login flow — it opens automatically.",
        });
      }

      const loginBtn = panel.createEl("button", {
        cls: "mod-cta ss-pi-wizard__oauth-login-btn",
        text: `Login with ${this.providerLabel(provider)}`,
      });
      loginBtn.disabled = this.actionRunning || this.cliStatus !== "success";
      // When in-modal auth is unavailable, clicking this falls back to terminal
      loginBtn.addEventListener("click", () => void this.startOAuthLoginInModal());

      if (this.inModalAuthAvailable) {
        // Secondary terminal/copy options only shown alongside the in-modal path
        const secondary = panel.createDiv({ cls: "ss-pi-wizard__actions ss-pi-wizard__actions--secondary" });
        const terminalBtn = secondary.createEl("button", { text: "Open in Terminal" });
        terminalBtn.disabled = this.actionRunning || this.cliStatus !== "success";
        terminalBtn.addEventListener("click", () => void this.launchProviderLoginInTerminal());
        const copyBtn = secondary.createEl("button", { text: "Copy Command" });
        copyBtn.disabled = this.actionRunning;
        copyBtn.addEventListener("click", () => void this.copyLoginCommand());
      } else {
        // Copy command is still useful so users can run it themselves
        const copyBtn = panel.createEl("button", { text: "Copy Login Command" });
        copyBtn.disabled = this.actionRunning;
        copyBtn.addEventListener("click", () => void this.copyLoginCommand());
      }
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
      // Pi auth module blocked — can't save keys in-modal. Show env var instructions.
      panel.createDiv({
        cls: "ss-pi-wizard__sandbox-notice",
        text: "Obsidian's sandbox prevents saving keys in-app. Set the environment variable before launching Obsidian:",
      });
      if (envVar) {
        const cmd = `export ${envVar}="your-api-key-here"`;
        const cmdRow = panel.createDiv({ cls: "ss-pi-wizard__cmd-row" });
        cmdRow.createEl("code", { cls: "ss-pi-wizard__cmd-code", text: cmd });
        const copyCmd = cmdRow.createEl("button", { text: "Copy" });
        copyCmd.addEventListener("click", async () => {
          const copied = await tryCopyToClipboard(cmd);
          new Notice(copied ? "Command copied." : "Unable to copy.");
        });
      }
      panel.createDiv({
        cls: "ss-pi-wizard__hint",
        text: "Or manually add your key to ~/.pi/agent/auth.json, then restart Obsidian.",
      });
      return;
    }

    panel.createDiv({
      cls: "ss-pi-wizard__hint",
      text: buildApiKeyHint(provider, envVar || undefined),
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
    const saveBtn = actions.createEl("button", { cls: "mod-cta", text: "Save API Key" });
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
      index: 3,
      title: "Verify models",
      description: "Confirms that your provider's models are accessible after auth.",
      status: this.modelStatus,
    });
    this.renderStepDetail(card, this.modelDetail);

    if (this.latestModelListStdout.trim()) {
      const count = parseProviderIdsFromModelList(this.latestModelListStdout).length;
      card.createDiv({
        cls: "ss-pi-wizard__hint",
        text: `${count} provider${count !== 1 ? "s" : ""} detected in Pi model list.`,
      });
    }

    const actions = card.createDiv({ cls: "ss-pi-wizard__actions" });
    const verifyBtn = actions.createEl("button", { cls: "mod-cta", text: "Verify Models" });
    verifyBtn.disabled = this.actionRunning || this.cliStatus !== "success";
    verifyBtn.addEventListener("click", () => void this.verifyModels());
  }

  private render(): void {
    this.contentEl.empty();
    this.renderBanner();
    this.renderCliStep();
    this.renderAuthStep();
    this.renderModelStep();

    // Collapsible error details
    const details = this.contentEl.createEl("details", { cls: "ss-pi-wizard__error-details" });
    details.createEl("summary", { text: "Technical error details" });
    details.createEl("pre", { cls: "ss-pi-wizard__error-pre", text: this.errorMessage });

    // Footer
    const footer = this.contentEl.createDiv({ cls: "ss-pi-wizard__footer" });
    const closeBtn = footer.createEl("button", { text: "Close" });
    closeBtn.disabled = this.actionRunning;
    closeBtn.addEventListener("click", () => this.close());

    const retryBtn = footer.createEl("button", {
      cls: "mod-cta",
      text: "Retry Studio Run",
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
