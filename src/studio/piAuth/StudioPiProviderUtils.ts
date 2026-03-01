export function normalizeStudioPiProviderHint(rawProvider: unknown): string {
  const normalized = String(rawProvider || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    return "";
  }
  return normalized;
}
