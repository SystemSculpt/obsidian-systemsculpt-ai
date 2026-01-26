import YAML from "yaml";

export type ObsidianBasesYamlValidationResult =
  | { ok: true }
  | { ok: false; problems: string[]; hint?: string };

const UNRESOLVED_TAG_RE = /\bUnresolved tag:/;

export function validateObsidianBasesYaml(yamlText: string): ObsidianBasesYamlValidationResult {
  const src = String(yamlText ?? "");
  const doc = YAML.parseDocument(src);

  const errors = doc.errors.map((e) => (e?.message || "").trim()).filter(Boolean);
  const warnings = doc.warnings.map((w) => (w?.message || "").trim()).filter(Boolean);
  const unresolvedTagWarnings = warnings.filter((w) => UNRESOLVED_TAG_RE.test(w));

  const problems = [...errors, ...unresolvedTagWarnings];
  if (problems.length === 0) {
    return { ok: true };
  }

  const hint = buildHint(problems);
  return hint ? { ok: false, problems, hint } : { ok: false, problems };
}

export function assertValidObsidianBasesYaml(path: string, yamlText: string): void {
  const result = validateObsidianBasesYaml(yamlText);
  if (result.ok) return;
  throw createObsidianBasesYamlError(path, result);
}

type ObsidianBasesYamlErrorDetails = {
  path: string;
  problems: string[];
  hint?: string;
};

function createObsidianBasesYamlError(
  path: string,
  validation: Exclude<ObsidianBasesYamlValidationResult, { ok: true }>
): Error & { code: string; details: ObsidianBasesYamlErrorDetails } {
  const maxProblems = 3;
  const shown = validation.problems.slice(0, maxProblems);
  const remaining = validation.problems.length - shown.length;

  const parts: string[] = [
    `Invalid Obsidian Bases YAML (.base): ${path}`,
  ];

  if (validation.hint) {
    parts.push(`Hint: ${validation.hint}`);
  }

  parts.push(`Parser problems (${validation.problems.length}):`);
  shown.forEach((problem, idx) => {
    parts.push(`\n[${idx + 1}] ${problem}`);
  });
  if (remaining > 0) {
    parts.push(`\n...and ${remaining} more.`);
  }

  const err: any = new Error(parts.join("\n"));
  err.code = "BASE_YAML_INVALID";
  err.details = {
    path,
    problems: validation.problems.slice(),
    ...(validation.hint ? { hint: validation.hint } : {}),
  };
  return err;
}

function buildHint(problems: string[]): string | null {
  const text = problems.join("\n");
  const looksLikeLeadingBangWasParsedAsTag =
    text.includes("Tags and anchors") ||
    text.includes("Unexpected scalar") ||
    text.includes("Unresolved tag:");

  if (!looksLikeLeadingBangWasParsedAsTag) {
    return null;
  }

  return [
    "Bases filters/formulas are YAML strings, not YAML tags.",
    "If an expression starts with `!` (negation), quote it (e.g. `'!status'` or `'!file.inFolder(\"Projects\")'`) or use a `not:` filter block instead.",
    "Unquoted leading `!` is interpreted by YAML as a tag and will break the file.",
  ].join(" ");
}
