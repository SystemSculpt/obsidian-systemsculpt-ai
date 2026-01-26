export function mentionsObsidianBases(text: string): boolean {
  const normalized = String(text ?? "").toLowerCase();
  if (!normalized) return false;

  // Strong signal: Obsidian Bases files use the `.base` extension.
  if (normalized.includes(".base")) return true;

  const hasBasesWord = /\bbases?\b/.test(normalized);
  if (!hasBasesWord) return false;

  // Disambiguate from unrelated uses of “base(s)” (e.g., base64).
  if (/\bobsidian\b/.test(normalized)) return true;
  if (normalized.includes("bases prompt")) return true;
  if (/\bbase\s+files?\b/.test(normalized)) return true;

  // Common Bases language users use when referring to database views in a vault.
  const contextualHints = [
    "vault",
    "database view",
    "table view",
    "filters",
    "formulas",
    "yaml",
  ];
  return contextualHints.some((hint) => normalized.includes(hint));
}
