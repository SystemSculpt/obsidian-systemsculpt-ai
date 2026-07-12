import { App, Notice } from "obsidian";
import { showPopup } from "../../core/ui/";

export type ChatAccountSetupPromptOverrides = Readonly<{
  title?: string;
  primaryButton?: string;
}>;

export function getChatAccountSetupMessage(options?: { retryHint?: boolean }): string {
  const retrySuffix = options?.retryHint ? ", then try again." : ".";
  return `Open Settings -> Account to activate your SystemSculpt license${retrySuffix}`;
}

export function getChatAccountSetupNotice(): string {
  return "Open Settings -> SystemSculpt AI -> Account to finish SystemSculpt setup.";
}

export function openChatAccount(openAccount: () => void): void {
  try {
    openAccount();
  } catch {
    new Notice(getChatAccountSetupNotice(), 6000);
  }
}

export async function promptChatAccountSetup(options: {
  app: App;
  openAccount: () => void;
  message?: string;
  retryHint?: boolean;
  overrides?: ChatAccountSetupPromptOverrides;
}): Promise<boolean> {
  const result = await showPopup(
    options.app,
    options.message ?? getChatAccountSetupMessage({ retryHint: options.retryHint }),
    {
      title: options.overrides?.title ?? "Finish setup",
      icon: "plug-zap",
      primaryButton: options.overrides?.primaryButton ?? "Open Account",
      secondaryButton: "Not Now",
    },
  );
  if (!result?.confirmed) return false;

  openChatAccount(options.openAccount);
  return true;
}
