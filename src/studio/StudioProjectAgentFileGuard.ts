import { validateStudioProjectForAgentEdit } from "./StudioProjectAgentContract";
import {
  assertStableStudioProjectAgentDocumentFieldsUnchanged,
  assertValidStudioProjectAgentDocumentStructure,
} from "./StudioProjectAgentDocumentValidation";
import { parseStudioProject } from "./schema";

export type StudioProjectAgentFileMutation = Readonly<{
  path: string;
  content?: string;
  previousContent?: string;
  exists: boolean;
  mode: "overwrite" | "append" | "edit" | "multi_edit";
}>;

function normalizeAgentMutationPath(path: string): string {
  return String(path || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "");
}

export function isStudioProjectDocumentPath(path: string): boolean {
  return normalizeAgentMutationPath(path).toLowerCase().endsWith(".systemsculpt");
}

export function isStudioOwnedPersistencePath(path: string): boolean {
  const normalized = normalizeAgentMutationPath(path).toLowerCase();
  return normalized.startsWith(".systemsculpt/studio/")
    || normalized.endsWith(".systemsculpt.identity.json")
    || normalized.includes(".systemsculpt-assets/")
    || normalized.endsWith(".systemsculpt-assets");
}

function parseAgentProjectDocument(rawText: string): Record<string, unknown> {
  const value = JSON.parse(rawText) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Studio project root must be a JSON object.");
  }
  const document = value as Record<string, unknown>;
  if (document.schema !== "studio.project.v1") {
    throw new Error("The Studio project schema must remain studio.project.v1.");
  }
  return document;
}

/**
 * Safety boundary for generic agent file tools. Every proposed Studio project
 * is parsed and compiled before FileOperations writes bytes.
 */
export function assertValidStudioProjectAgentFileMutation(
  mutation: StudioProjectAgentFileMutation
): void {
  const path = normalizeAgentMutationPath(mutation.path);
  if (isStudioOwnedPersistencePath(path)) {
    throw new Error(
      "Edit the .systemsculpt project file, not SystemSculpt's private project files."
    );
  }
  if (!isStudioProjectDocumentPath(path)) {
    return;
  }
  if (!mutation.exists) {
    throw new Error(
      "Create this project in Studio once, then edit its .systemsculpt file with the usual file tools."
    );
  }
  if (mutation.mode === "append") {
    throw new Error("A .systemsculpt project is one JSON document and cannot be appended to. Use edit or overwrite.");
  }
  if (typeof mutation.content !== "string") {
    return;
  }

  try {
    const document = parseAgentProjectDocument(mutation.content);
    assertValidStudioProjectAgentDocumentStructure(document);
    if (typeof mutation.previousContent === "string") {
      const previous = parseAgentProjectDocument(mutation.previousContent);
      assertStableStudioProjectAgentDocumentFieldsUnchanged(document, previous);
    }
    const project = parseStudioProject(mutation.content);
    validateStudioProjectForAgentEdit(project);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Studio project edit rejected before write: ${detail}`);
  }
}
