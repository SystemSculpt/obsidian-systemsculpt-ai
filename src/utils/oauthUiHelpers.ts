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
  const trimmed = String(url || "").trim();
  if (!trimmed) {
    return;
  }
  const runtimeRequire = typeof window !== "undefined" ? (window as any)?.require : null;
  const electron = typeof runtimeRequire === "function" ? runtimeRequire("electron") : null;
  const shell = electron?.shell;
  try {
    if (typeof shell?.openExternal === "function") {
      await shell.openExternal(trimmed);
      return;
    }
  } catch {
    // Fall back to window.open below.
  }
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(trimmed, "_blank", "noopener,noreferrer");
  }
}
