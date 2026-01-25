import type { TFile } from "obsidian";
import type SystemSculptPlugin from "../main";

export type QuickEditIssueCode =
  | "missing-model"
  | "unsupported-file";

export interface QuickEditIssue {
  code: QuickEditIssueCode;
  message: string;
  action?: string;
}

export interface QuickEditReadinessOptions {
  plugin: SystemSculptPlugin;
  file: TFile;
  allowedExtensions?: string[];
}

export interface QuickEditReadinessResult {
  ok: boolean;
  issues: QuickEditIssue[];
}

const DEFAULT_EXTENSIONS = ["md", "markdown", "txt", "canvas", "json", "yaml", "yml"];

export async function evaluateQuickEditReadiness(
  options: QuickEditReadinessOptions
): Promise<QuickEditReadinessResult> {
  const { plugin, file } = options;
  const allowedExtensions = options.allowedExtensions ?? DEFAULT_EXTENSIONS;
  const issues: QuickEditIssue[] = [];

  const modelId = plugin?.settings?.selectedModelId ?? "";
  if (!modelId || typeof modelId !== "string" || modelId.trim().length === 0) {
    issues.push({
      code: "missing-model",
      message: "Select a default model in SystemSculpt settings to run Quick Edit.",
      action: "Open SystemSculpt → Models → choose a default model.",
    });
  }

  // Internal filesystem tools are always available - no settings checks needed
  // (mcpEnabled and mcpEnabledTools settings are deprecated)

  const extension = (file?.extension ?? "").toLowerCase();
  if (!allowedExtensions.includes(extension)) {
    issues.push({
      code: "unsupported-file",
      message: `Quick Edit supports text notes only. "${extension || "unknown"}" files are read-only.`,
    });
  }

  return { ok: issues.length === 0, issues };
}
