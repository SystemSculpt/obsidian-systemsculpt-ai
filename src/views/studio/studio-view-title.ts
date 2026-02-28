export const DEFAULT_STUDIO_VIEW_TITLE = "SystemSculpt Studio";

export function resolveStudioViewTitle(projectPath: string | null | undefined): string {
  const rawPath = String(projectPath || "").trim();
  if (!rawPath) {
    return DEFAULT_STUDIO_VIEW_TITLE;
  }

  const normalized = rawPath.replace(/\\/g, "/");
  const filename = normalized.split("/").filter(Boolean).pop();
  if (!filename) {
    return DEFAULT_STUDIO_VIEW_TITLE;
  }

  return filename;
}
