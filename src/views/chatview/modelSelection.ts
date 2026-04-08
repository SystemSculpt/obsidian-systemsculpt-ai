import { App, Notice } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { showPopup } from "../../core/ui/";
import { getDisplayName, ensureCanonicalId } from "../../utils/modelUtils";
import type { SystemSculptModel } from "../../types/llm";
import {
  getManagedSystemSculptModelId,
  hasManagedSystemSculptAccess,
  isManagedSystemSculptModelId,
} from "../../services/systemsculpt/ManagedSystemSculptModel";
import {
  loadPiTextLocalProviderIds,
  loadPiTextProviderAuth,
  piTextProviderRequiresAuth,
} from "../../services/pi-native/PiTextAuth";
import { PlatformContext } from "../../services/PlatformContext";
import { normalizeStudioPiProviderId } from "../../studio/piAuth/StudioPiProviderAuthUtils";
import {
  isStudioPiLocalProvider,
  resolveProviderLabel,
} from "../../studio/piAuth/StudioPiProviderRegistry";

export type ChatModelSetupTab = "account" | "providers";

export type ChatModelSetupSurface = {
  targetTab: ChatModelSetupTab;
  title: string;
  primaryButton: string;
};

export type ChatModelSetupPromptOverrides = {
  title?: string;
  primaryButton?: string;
  targetTab?: ChatModelSetupTab;
};

export type ChatModelPickerSection = "systemsculpt" | "pi" | "local";

export type ChatModelPickerOption = {
  value: string;
  label: string;
  description?: string;
  badge?: string;
  keywords?: string[];
  providerAuthenticated: boolean;
  providerId: string;
  providerLabel: string;
  contextLabel?: string;
  section: ChatModelPickerSection;
  icon: string;
  setupSurface: ChatModelSetupSurface;
};

export function getEffectiveChatModelId(
  selectedModelId?: string | null,
  fallbackModelId?: string | null,
): string {
  return (
    ensureCanonicalId(String(selectedModelId || "").trim()) ||
    ensureCanonicalId(String(fallbackModelId || "").trim()) ||
    getManagedSystemSculptModelId()
  );
}

export function getChatModelDisplayName(
  selectedModelId?: string | null,
  fallbackModelId?: string | null,
): string {
  return getDisplayName(getEffectiveChatModelId(selectedModelId, fallbackModelId));
}

export function getChatModelSetupSurface(
  selectedModelId?: string | null,
  fallbackModelId?: string | null,
): ChatModelSetupSurface {
  return isManagedSystemSculptModelId(getEffectiveChatModelId(selectedModelId, fallbackModelId))
    ? {
        targetTab: "account",
        title: "Finish setup",
        primaryButton: "Open Account",
      }
    : {
        targetTab: "providers",
        title: "Finish provider setup",
        primaryButton: "Open Providers",
      };
}

export function getChatModelSetupMessage(
  targetTab: ChatModelSetupTab,
  options?: { retryHint?: boolean },
): string {
  const retrySuffix = options?.retryHint ? ", then try again." : ".";
  return targetTab === "providers"
    ? `Open Settings -> Providers to connect the selected provider${retrySuffix}`
    : `Open Settings -> Account to activate your SystemSculpt license${retrySuffix}`;
}

export function getChatModelSetupNotice(targetTab: ChatModelSetupTab): string {
  return targetTab === "providers"
    ? "Open Settings -> SystemSculpt AI -> Providers to finish provider setup."
    : "Open Settings -> SystemSculpt AI -> Account to finish SystemSculpt setup.";
}

export function openChatModelSetupTab(
  openSettingsTab: (targetTab: ChatModelSetupTab) => void,
  targetTab: ChatModelSetupTab = "account",
): void {
  try {
    openSettingsTab(targetTab);
  } catch {
    new Notice(getChatModelSetupNotice(targetTab), 6000);
  }
}

export async function promptChatModelSetup(options: {
  app: App;
  openSettingsTab: (targetTab: ChatModelSetupTab) => void;
  selectedModelId?: string | null;
  fallbackModelId?: string | null;
  message?: string;
  retryHint?: boolean;
  overrides?: ChatModelSetupPromptOverrides;
}): Promise<boolean> {
  const baseSurface = getChatModelSetupSurface(
    options.selectedModelId,
    options.fallbackModelId,
  );
  const setupSurface = {
    ...baseSurface,
    ...options.overrides,
  };
  const targetTab = setupSurface.targetTab || "account";
  const result = await showPopup(
    options.app,
    options.message ?? getChatModelSetupMessage(targetTab, { retryHint: options.retryHint }),
    {
      title: setupSurface.title || "Finish setup",
      icon: "plug-zap",
      primaryButton: setupSurface.primaryButton || "Open Account",
      secondaryButton: "Not Now",
    },
  );
  if (!result?.confirmed) {
    return false;
  }

  openChatModelSetupTab(options.openSettingsTab, targetTab);
  return true;
}

export function formatChatModelContextLength(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "";
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M context`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K context`;
  }
  return `${Math.floor(tokens)} context`;
}

export function buildChatModelDescription(
  model: Pick<SystemSculptModel, "description" | "context_length" | "id">,
  providerAuthenticated: boolean,
): string {
  const descriptionParts: string[] = [];
  const modelDescription = String(model.description || "").trim();
  if (modelDescription) {
    descriptionParts.push(modelDescription);
  }

  const contextLabel = formatChatModelContextLength(Number(model.context_length || 0));
  if (contextLabel && !descriptionParts.some((entry) => /context/i.test(entry))) {
    descriptionParts.push(contextLabel);
  }

  if (!providerAuthenticated && !isManagedSystemSculptModelId(model.id)) {
    descriptionParts.push("Open Providers in Settings to finish setup before sending.");
  }

  return descriptionParts.join(" • ");
}

function resolveChatModelPickerSection(
  model: Pick<SystemSculptModel, "id" | "sourceProviderId" | "provider">,
): ChatModelPickerSection {
  if (isManagedSystemSculptModelId(model.id)) {
    return "systemsculpt";
  }

  const providerId = normalizeStudioPiProviderId(model.sourceProviderId || model.provider);
  if (providerId && isStudioPiLocalProvider(providerId)) {
    return "local";
  }

  return "pi";
}

export function getChatModelPickerSectionLabel(section: ChatModelPickerSection): string {
  switch (section) {
    case "systemsculpt":
      return "SystemSculpt";
    case "local":
      return "Local Models";
    case "pi":
    default:
      return "Pi Providers";
  }
}

function getChatModelPickerSectionOrder(section: ChatModelPickerSection): number {
  switch (section) {
    case "systemsculpt":
      return 0;
    case "pi":
      return 1;
    case "local":
    default:
      return 2;
  }
}

export function getChatModelPickerIcon(section: ChatModelPickerSection): string {
  switch (section) {
    case "systemsculpt":
      return "sparkles";
    case "local":
      return "hard-drive";
    case "pi":
    default:
      return "cloud";
  }
}

export function buildChatModelPickerOption(
  model: Pick<
    SystemSculptModel,
    | "id"
    | "name"
    | "description"
    | "context_length"
    | "provider"
    | "sourceProviderId"
    | "piExecutionModelId"
    | "sourceMode"
    | "piLocalAvailable"
    | "piRemoteAvailable"
  >,
  providerAuthenticated: boolean,
): ChatModelPickerOption {
  const providerId = String(model.sourceProviderId || model.provider || "").trim();
  const providerLabel = isManagedSystemSculptModelId(model.id)
    ? "SystemSculpt"
    : resolveProviderLabel(providerId || model.provider);
  const contextLabel = formatChatModelContextLength(Number(model.context_length || 0)).replace(/\s+context$/i, "");
  const section = resolveChatModelPickerSection(model);

  return {
    value: model.id,
    label: String(model.name || "").trim() || String(model.id || "").trim(),
    description: buildChatModelDescription(model, providerAuthenticated) || undefined,
    badge: providerLabel || undefined,
    keywords: [
      String(model.name || "").trim(),
      String(model.id || "").trim(),
      String(model.description || "").trim(),
      String(model.provider || "").trim(),
      String(model.sourceProviderId || "").trim(),
      String(model.piExecutionModelId || "").trim(),
    ].filter((entry) => entry.length > 0),
    providerAuthenticated,
    providerId,
    providerLabel,
    contextLabel: contextLabel || undefined,
    section,
    icon: getChatModelPickerIcon(section),
    setupSurface: getChatModelSetupSurface(model.id),
  };
}

export function compareChatModelPickerOptions(
  left: ChatModelPickerOption,
  right: ChatModelPickerOption,
): number {
  const sectionCompare =
    getChatModelPickerSectionOrder(left.section) - getChatModelPickerSectionOrder(right.section);
  if (sectionCompare !== 0) {
    return sectionCompare;
  }

  const authCompare = Number(Boolean(right.providerAuthenticated)) - Number(Boolean(left.providerAuthenticated));
  if (authCompare !== 0) {
    return authCompare;
  }

  const providerCompare = left.providerLabel.localeCompare(right.providerLabel);
  if (providerCompare !== 0) {
    return providerCompare;
  }

  return left.label.localeCompare(right.label);
}

export function getChatModelPickerSearchText(option: ChatModelPickerOption): string {
  const parts: string[] = [
    option.label,
    option.value,
    option.description || "",
    option.badge || "",
    option.providerLabel || "",
    option.contextLabel || "",
  ];
  if (Array.isArray(option.keywords)) {
    parts.push(...option.keywords);
  }
  return parts.join(" ");
}

export async function loadChatModelPickerOptions(
  plugin: Pick<SystemSculptPlugin, "modelService" | "settings">,
): Promise<ChatModelPickerOption[]> {
  const models = plugin.modelService?.getModels
    ? await plugin.modelService.getModels().catch(() => [] as SystemSculptModel[])
    : [];

  const providerHints = Array.from(
    new Set(
      models
        .filter((model) => !isManagedSystemSculptModelId(model.id))
        .map((model) => String(model.sourceProviderId || model.provider || "").trim())
        .filter((providerId) => providerId.length > 0)
    )
  );

  const desktopPlugin = plugin as SystemSculptPlugin;
  const [providerAuth, localProviderIds] = await Promise.all([
    loadPiTextProviderAuth(providerHints, desktopPlugin),
    PlatformContext.get().supportsDesktopOnlyFeatures()
      ? loadPiTextLocalProviderIds(desktopPlugin)
      : Promise.resolve(new Set<string>()),
  ]);

  return models
    .map((model) => {
      const providerHint = String(model.sourceProviderId || model.provider || "").trim();
      const normalizedProviderId = normalizeStudioPiProviderId(providerHint);
      const section = resolveChatModelPickerSection(model);
      const authRecord = normalizedProviderId
        ? providerAuth.get(normalizedProviderId)
        : undefined;
      const providerAuthenticated = isManagedSystemSculptModelId(model.id)
        ? hasManagedSystemSculptAccess(desktopPlugin)
        : section === "local"
          ? Boolean(normalizedProviderId && localProviderIds.has(normalizedProviderId))
          : !piTextProviderRequiresAuth(providerHint) || Boolean(authRecord?.hasAnyAuth);
      return buildChatModelPickerOption(model, providerAuthenticated);
    })
    .sort(compareChatModelPickerOptions);
}
