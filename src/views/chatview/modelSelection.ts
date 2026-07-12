import { App, Notice } from "obsidian";
import { showPopup } from "../../core/ui/";

export const STANDARD_CHAT_PERSISTED_MODEL_ID =
  "systemsculpt@@systemsculpt/ai-agent" as const;

export const STANDARD_CHAT_IDENTITY = Object.freeze({
  persistedId: STANDARD_CHAT_PERSISTED_MODEL_ID,
  providerLabel: "SystemSculpt",
  modelLabel: "ai-agent",
  wireModel: "ai-agent",
} as const);

export type ChatModelSetupPromptOverrides = Readonly<{
  title?: string;
  primaryButton?: string;
}>;

export type ChatModelPickerOption = Readonly<{
  value: typeof STANDARD_CHAT_PERSISTED_MODEL_ID;
  label: typeof STANDARD_CHAT_IDENTITY.providerLabel;
  modelLabel: typeof STANDARD_CHAT_IDENTITY.modelLabel;
  icon: "sparkles";
}>;

const STANDARD_CHAT_SETUP_SURFACE = Object.freeze({
  title: "Finish setup",
  primaryButton: "Open Account",
} as const);

const STANDARD_CHAT_MODEL_OPTION: ChatModelPickerOption = Object.freeze({
  value: STANDARD_CHAT_PERSISTED_MODEL_ID,
  label: STANDARD_CHAT_IDENTITY.providerLabel,
  modelLabel: STANDARD_CHAT_IDENTITY.modelLabel,
  icon: "sparkles",
});

/**
 * Standard Chat deliberately has one identity. Candidates are migration input,
 * never runtime choices, so normalization must happen before any lookup or
 * branch can observe the historical value.
 */
export function normalizeStandardChatModelId(
  _candidate?: string | null,
): typeof STANDARD_CHAT_PERSISTED_MODEL_ID {
  return STANDARD_CHAT_PERSISTED_MODEL_ID;
}

export function getEffectiveChatModelId(
  selectedModelId?: string | null,
  _fallbackModelId?: string | null,
): typeof STANDARD_CHAT_PERSISTED_MODEL_ID {
  return normalizeStandardChatModelId(selectedModelId);
}

export function getChatModelDisplayName(
  _selectedModelId?: string | null,
  _fallbackModelId?: string | null,
): typeof STANDARD_CHAT_IDENTITY.providerLabel {
  return STANDARD_CHAT_IDENTITY.providerLabel;
}

export function getChatModelSetupMessage(options?: { retryHint?: boolean }): string {
  const retrySuffix = options?.retryHint ? ", then try again." : ".";
  return `Open Settings -> Account to activate your SystemSculpt license${retrySuffix}`;
}

export function getChatModelSetupNotice(): string {
  return "Open Settings -> SystemSculpt AI -> Account to finish SystemSculpt setup.";
}

export function openChatAccount(openAccount: () => void): void {
  try {
    openAccount();
  } catch {
    new Notice(getChatModelSetupNotice(), 6000);
  }
}

export async function promptChatModelSetup(options: {
  app: App;
  openAccount: () => void;
  message?: string;
  retryHint?: boolean;
  overrides?: ChatModelSetupPromptOverrides;
}): Promise<boolean> {
  const result = await showPopup(
    options.app,
    options.message ?? getChatModelSetupMessage({ retryHint: options.retryHint }),
    {
      title: options.overrides?.title ?? STANDARD_CHAT_SETUP_SURFACE.title,
      icon: "plug-zap",
      primaryButton:
        options.overrides?.primaryButton ?? STANDARD_CHAT_SETUP_SURFACE.primaryButton,
      secondaryButton: "Not Now",
    },
  );
  if (!result?.confirmed) {
    return false;
  }

  openChatAccount(options.openAccount);
  return true;
}

export function getStandardChatModelOption(): ChatModelPickerOption {
  return STANDARD_CHAT_MODEL_OPTION;
}

/**
 * Keep the optional source argument for automation callers, but intentionally
 * never inspect it: Standard Chat has no catalog/provider dependency.
 */
export async function loadChatModelPickerOptions(
  _source?: object,
): Promise<ChatModelPickerOption[]> {
  return [STANDARD_CHAT_MODEL_OPTION];
}
