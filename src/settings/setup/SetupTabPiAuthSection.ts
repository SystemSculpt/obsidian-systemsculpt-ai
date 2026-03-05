import { Notice, Setting } from "obsidian";
import type { CustomProvider } from "../../types/llm";
import {
  clearStudioPiProviderAuth,
  listStudioPiProviderAuthRecords,
  migrateStudioPiProviderApiKeys,
  setStudioPiProviderApiKey,
  type StudioPiApiKeyMigrationCandidate,
  type StudioPiApiKeyMigrationEntry,
  type StudioPiProviderAuthRecord,
} from "../../studio/StudioLocalTextModelCatalog";
import {
  hasAuthenticatedStudioPiProvider,
  normalizeStudioPiProviderId,
} from "../../studio/piAuth/StudioPiProviderAuthUtils";
import {
  getDefaultStudioPiProviderHints,
  KNOWN_OAUTH_PROVIDER_IDS,
  resolvePiProviderFromEndpoint,
  resolveProviderLabel,
} from "../../studio/piAuth/StudioPiProviderRegistry";
import { SystemSculptSettingTab } from "../SystemSculptSettingTab";
import { runSetupPiOAuthLogin } from "../piAuth/SetupPiOAuthFlow";

const STUDIO_PI_AUTH_MIGRATION_VERSION = 1;

export type StudioPiAuthMigrationSkipReason =
  | "missing_api_key"
  | "unmapped_endpoint"
  | "duplicate_provider_mapping";

export type StudioPiAuthMigrationSkip = {
  source: string;
  reason: StudioPiAuthMigrationSkipReason;
  providerId?: string;
};

export type StudioPiAuthMigrationCandidateSet = {
  candidates: StudioPiApiKeyMigrationCandidate[];
  skipped: StudioPiAuthMigrationSkip[];
};

function normalizeProviderId(value: string): string {
  return normalizeStudioPiProviderId(value);
}

function formatPiProviderLabel(record: StudioPiProviderAuthRecord): string {
  const normalized = normalizeProviderId(record.provider);
  if (record.displayName?.trim()) {
    return record.displayName.trim();
  }
  return resolveProviderLabel(normalized);
}

function summarizePiAuthRecord(record: StudioPiProviderAuthRecord): string {
  if (record.source === "oauth") {
    if (record.oauthExpiresAt && Number.isFinite(record.oauthExpiresAt)) {
      const date = new Date(record.oauthExpiresAt);
      if (!Number.isNaN(date.getTime())) {
        return `OAuth token stored in auth.json. Expires ${date.toLocaleString()}.`;
      }
    }
    return "OAuth token stored in auth.json.";
  }
  if (record.source === "api_key") {
    return "API key stored in auth.json.";
  }
  if (record.source === "environment_or_fallback") {
    return "Credentials resolved from environment or fallback config.";
  }
  return "No credentials configured yet.";
}

function hasStoredPiCredential(record: StudioPiProviderAuthRecord): boolean {
  return hasAuthenticatedStudioPiProvider(record);
}

export function compareStudioPiAuthRecords(
  left: StudioPiProviderAuthRecord,
  right: StudioPiProviderAuthRecord
): number {
  const leftHasStoredCredential = hasStoredPiCredential(left);
  const rightHasStoredCredential = hasStoredPiCredential(right);
  if (leftHasStoredCredential !== rightHasStoredCredential) {
    return leftHasStoredCredential ? -1 : 1;
  }

  if (left.hasAnyAuth !== right.hasAnyAuth) {
    return left.hasAnyAuth ? -1 : 1;
  }

  return formatPiProviderLabel(left).localeCompare(formatPiProviderLabel(right));
}

function getPiApiKeyButtonText(record: StudioPiProviderAuthRecord): string {
  return record.credentialType === "api_key" ? "API key ✓" : "Set API key";
}

function getPiApiKeyButtonTooltip(record: StudioPiProviderAuthRecord): string {
  if (record.credentialType === "api_key") {
    return `API key saved for ${record.provider}. Click to replace it.`;
  }
  return `Save API key for ${record.provider}`;
}

function getPiOAuthButtonText(record: StudioPiProviderAuthRecord): string {
  if (!record.supportsOAuth) {
    return "OAuth n/a";
  }
  return record.credentialType === "oauth" ? "OAuth ✓" : "OAuth login";
}

function getPiOAuthButtonTooltip(record: StudioPiProviderAuthRecord): string {
  if (!record.supportsOAuth) {
    return "Provider is API-key only";
  }
  if (record.credentialType === "oauth") {
    return `OAuth already configured for ${record.provider}. Click to refresh login.`;
  }
  return `Run OAuth login for ${record.provider}`;
}

function summarizeMigrationRollup(migrated: number, skipped: number, errors: number): string {
  const parts = [`migrated ${migrated}`];
  if (skipped > 0) {
    parts.push(`skipped ${skipped}`);
  }
  if (errors > 0) {
    parts.push(`errors ${errors}`);
  }
  return parts.join(", ");
}

function summarizeMigrationSkip(entry: StudioPiApiKeyMigrationEntry): string {
  if (entry.reason === "existing_oauth") {
    return "existing OAuth credentials";
  }
  if (entry.reason === "existing_api_key") {
    return "existing API key credentials";
  }
  if (entry.reason === "existing_stored_credential") {
    return "existing stored credentials";
  }
  if (entry.reason === "invalid_provider") {
    return "invalid provider";
  }
  if (entry.reason === "empty_key") {
    return "empty API key";
  }
  return entry.reason || "skipped";
}

export function deriveStudioPiMigrationCandidates(
  providers: CustomProvider[],
  legacyOpenAiApiKey: string
): StudioPiAuthMigrationCandidateSet {
  const candidates: StudioPiApiKeyMigrationCandidate[] = [];
  const skipped: StudioPiAuthMigrationSkip[] = [];
  const seenProviders = new Set<string>();

  for (const provider of providers) {
    const apiKey = String(provider.apiKey || "").trim();
    const source = `custom-provider:${provider.id || provider.name || "<unknown>"}`;
    if (!apiKey) {
      skipped.push({
        source,
        reason: "missing_api_key",
      });
      continue;
    }
    const mappedProvider = resolvePiProviderFromEndpoint(provider.endpoint || "");
    if (!mappedProvider) {
      skipped.push({
        source,
        reason: "unmapped_endpoint",
      });
      continue;
    }
    if (seenProviders.has(mappedProvider)) {
      skipped.push({
        source,
        reason: "duplicate_provider_mapping",
        providerId: mappedProvider,
      });
      continue;
    }
    seenProviders.add(mappedProvider);
    candidates.push({
      providerId: mappedProvider,
      apiKey,
      origin: source,
    });
  }

  const normalizedLegacyOpenAiApiKey = String(legacyOpenAiApiKey || "").trim();
  if (normalizedLegacyOpenAiApiKey) {
    if (!seenProviders.has("openai")) {
      candidates.push({
        providerId: "openai",
        apiKey: normalizedLegacyOpenAiApiKey,
        origin: "legacy:openAiApiKey",
      });
    } else {
      skipped.push({
        source: "legacy:openAiApiKey",
        reason: "duplicate_provider_mapping",
        providerId: "openai",
      });
    }
  }

  return {
    candidates,
    skipped,
  };
}

let studioPiMigrationInFlight = false;

async function maybeRunStudioPiAuthMigration(tabInstance: SystemSculptSettingTab): Promise<void> {
  const currentVersion = Number(tabInstance.plugin.settings.studioPiAuthMigrationVersion || 0);
  if (currentVersion >= STUDIO_PI_AUTH_MIGRATION_VERSION || studioPiMigrationInFlight) {
    return;
  }

  studioPiMigrationInFlight = true;
  try {
    const migrationInput = deriveStudioPiMigrationCandidates(
      tabInstance.plugin.settings.customProviders || [],
      tabInstance.plugin.settings.openAiApiKey || ""
    );

    const report = await migrateStudioPiProviderApiKeys(migrationInput.candidates);
    const skippedBecauseInput = migrationInput.skipped.length;
    const skippedBecauseStorage = report.skipped.length;
    const totalSkipped = skippedBecauseInput + skippedBecauseStorage;
    const totalErrors = report.errors.length;

    await tabInstance.plugin.getSettingsManager().updateSettings({
      studioPiAuthMigrationVersion: STUDIO_PI_AUTH_MIGRATION_VERSION,
    });

    if (report.migrated.length > 0 || totalSkipped > 0 || totalErrors > 0) {
      new Notice(
        `Local Pi auth migration complete: ${summarizeMigrationRollup(
          report.migrated.length,
          totalSkipped,
          totalErrors
        )}.`,
        6000
      );
    }

    if (report.skipped.length > 0) {
      const preview = report.skipped
        .slice(0, 3)
        .map((entry) => `${entry.provider} (${summarizeMigrationSkip(entry)})`)
        .join(", ");
      if (preview) {
        new Notice(`Pi auth migration skipped: ${preview}${report.skipped.length > 3 ? ", …" : ""}`, 6000);
      }
    }

    if (migrationInput.skipped.length > 0) {
      const mappedPreview = migrationInput.skipped
        .slice(0, 3)
        .map((entry) => {
          if (entry.reason === "unmapped_endpoint") return `${entry.source} (unmapped endpoint)`;
          if (entry.reason === "missing_api_key") return `${entry.source} (missing API key)`;
          return `${entry.source} (${entry.providerId || "duplicate"})`;
        })
        .join(", ");
      if (mappedPreview) {
        new Notice(
          `Pi auth migration inputs skipped: ${mappedPreview}${migrationInput.skipped.length > 3 ? ", …" : ""}`,
          6000
        );
      }
    }

    if (report.errors.length > 0) {
      const firstError = report.errors[0];
      new Notice(
        `Pi auth migration error for ${firstError.provider}: ${firstError.message || "unknown error"}`,
        7000
      );
    }
  } finally {
    studioPiMigrationInFlight = false;
  }
}

function collectPiProviderHints(customProviders: CustomProvider[]): string[] {
  const hintSet = new Set<string>(getDefaultStudioPiProviderHints());
  for (const customProvider of customProviders) {
    const mapped = resolvePiProviderFromEndpoint(customProvider.endpoint || "");
    if (mapped) {
      hintSet.add(mapped);
    }
  }
  return Array.from(hintSet.values());
}

export function renderLocalPiAuthSection(root: HTMLElement, tabInstance: SystemSculptSettingTab): void {
  root.createEl("h3", { text: "Local Pi Auth" });

  const summarySetting = new Setting(root)
    .setName("Pi-first authentication")
    .setDesc("Manage Local Pi OAuth and API keys proactively. Credentials stay local in ~/.pi/agent/auth.json.");

  const recordsRoot = root.createDiv({ cls: "ss-setup-pi-auth-list" });

  const refreshRecords = async () => {
    summarySetting.setDesc("Loading Local Pi auth providers…");
    recordsRoot.empty();

    try {
      await maybeRunStudioPiAuthMigration(tabInstance);

      const providerHints = collectPiProviderHints(tabInstance.plugin.settings.customProviders || []);
      const records = await listStudioPiProviderAuthRecords({ providerHints });
      for (const oauthOnlyProvider of KNOWN_OAUTH_PROVIDER_IDS.values()) {
        if (!records.some((record) => normalizeProviderId(record.provider) === oauthOnlyProvider)) {
          records.push({
            provider: oauthOnlyProvider,
            displayName: resolveProviderLabel(oauthOnlyProvider),
            supportsOAuth: true,
            hasAnyAuth: false,
            hasStoredCredential: false,
            source: "none",
            credentialType: "none",
            oauthExpiresAt: null,
          });
        }
      }

      if (records.length === 0) {
        summarySetting.setDesc("No Local Pi providers detected yet. Add credentials below or run `pi --list-models` once.");
        return;
      }

      records.sort(compareStudioPiAuthRecords);
      summarySetting.setDesc(
        `${records.length} provider${records.length === 1 ? "" : "s"} available. Secrets are never shown here.`
      );

      for (const record of records) {
        const setting = new Setting(recordsRoot)
          .setName(formatPiProviderLabel(record))
          .setDesc(summarizePiAuthRecord(record));
        setting.settingEl.classList.add("ss-setup-pi-auth-row");
        if (hasStoredPiCredential(record)) {
          setting.settingEl.classList.add("is-authenticated");
        }

        setting.addButton((button) => {
          button
            .setButtonText(getPiApiKeyButtonText(record))
            .setTooltip(getPiApiKeyButtonTooltip(record))
            .onClick(async () => {
              const actionLabel = record.credentialType === "api_key" ? "Update" : "Set";
              const rawValue = window.prompt(
                `${actionLabel} API key for ${formatPiProviderLabel(record)} (${record.provider}):`,
                ""
              );
              if (rawValue === null) {
                return;
              }
              const apiKey = String(rawValue || "").trim();
              if (!apiKey) {
                new Notice("API key cannot be empty.");
                return;
              }
              try {
                await setStudioPiProviderApiKey(record.provider, apiKey);
                new Notice(`Saved API key for ${formatPiProviderLabel(record)}.`);
                await refreshRecords();
              } catch (error: any) {
                new Notice(`Failed to save key for ${formatPiProviderLabel(record)}: ${error?.message || error}`);
              }
            });
        });

        setting.addButton((button) => {
          button
            .setButtonText(getPiOAuthButtonText(record))
            .setTooltip(getPiOAuthButtonTooltip(record))
            .setDisabled(!record.supportsOAuth)
            .onClick(async () => {
              try {
                await runSetupPiOAuthLogin({
                  app: tabInstance.app,
                  record,
                  providerLabel: formatPiProviderLabel(record),
                });
                new Notice(`OAuth login complete for ${formatPiProviderLabel(record)}.`);
                await refreshRecords();
              } catch (error: any) {
                const message = error?.message || error;
                new Notice(`Failed OAuth login for ${formatPiProviderLabel(record)}: ${message}`);
              }
            });
        });

        setting.addExtraButton((button) => {
          button
            .setIcon("trash")
            .setTooltip(`Clear stored auth for ${record.provider}`)
            .onClick(async () => {
              try {
                await clearStudioPiProviderAuth(record.provider);
                new Notice(`Cleared stored auth for ${formatPiProviderLabel(record)}.`);
                await refreshRecords();
              } catch (error: any) {
                new Notice(`Failed to clear auth for ${formatPiProviderLabel(record)}: ${error?.message || error}`);
              }
            });
        });

        setting.addExtraButton((button) => {
          button
            .setIcon("refresh-cw")
            .setTooltip(`Refresh auth state for ${record.provider}`)
            .onClick(async () => {
              await refreshRecords();
            });
        });
      }
    } catch (error: any) {
      const message = error?.message || String(error);
      summarySetting.setDesc(`Local Pi auth is unavailable right now: ${message}`);
      recordsRoot.createEl("p", {
        text: "If Pi auth storage is unavailable in this runtime, use Studio's recovery wizard or run `pi /login <provider>` in Terminal.",
        cls: "setting-item-description",
      });
    }
  };

  summarySetting.addButton((button) => {
    button.setButtonText("Refresh").onClick(async () => {
      await refreshRecords();
    });
  });

  void refreshRecords();
}
