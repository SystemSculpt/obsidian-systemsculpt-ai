import { openExternalUrl } from "./externalUrl";

export type OAuthPromptLike = {
  message?: unknown;
  placeholder?: unknown;
};

export function isOAuthCodePrompt(prompt: OAuthPromptLike): boolean {
  const message = String(prompt?.message || "").toLowerCase();
  const placeholder = String(prompt?.placeholder || "").toLowerCase();
  const combined = `${message} ${placeholder}`;
  return (
    combined.includes("authorization code") ||
    combined.includes("redirect url") ||
    combined.includes("oauth code")
  );
}

export async function openExternalUrlForOAuth(url: string): Promise<void> {
  await openExternalUrl(url);
}
