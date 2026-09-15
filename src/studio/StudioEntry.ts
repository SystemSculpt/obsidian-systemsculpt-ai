import { normalizePath } from 'obsidian';

type Reader = { read(path: string): Promise<string> };
export type StudioEntryResolution = { path: string; raw: string; entryRaw?: string };

/** A small, stable vault link may point at the view projection inside its authoring directory. */
export async function resolveStudioEntry(adapter: Reader, projectPath: string): Promise<StudioEntryResolution> {
  const raw = await adapter.read(projectPath);
  let entry: unknown;
  try { entry = JSON.parse(raw); } catch { return { path: projectPath, raw }; }
  if (!entry || typeof entry !== 'object' || (entry as { schema?: string }).schema !== 'studio.entry.v1') return { path: projectPath, raw };
  const value = entry as { id?: unknown; projection?: unknown };
  if (raw.length > 8192 || typeof value.id !== 'string' || !value.id || typeof value.projection !== 'string') throw new Error('Invalid Studio directory entry.');
  const parts = value.projection.split('/');
  if (parts.length < 2 || !parts[0].endsWith('.studio') || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes(':')) || !value.projection.endsWith('.systemsculpt')) throw new Error('Studio projection must be inside an adjacent .studio directory.');
  const folder = projectPath.slice(0, Math.max(0, projectPath.lastIndexOf('/') + 1));
  const path = normalizePath(folder + value.projection);
  const projection = await adapter.read(path);
  const document = JSON.parse(projection) as { schema?: string; id?: string; projectId?: string };
  if (!['studio.project.v1','studio.project.v2'].includes(document.schema || '') || (document.id || document.projectId) !== value.id) throw new Error('Studio entry and projection identities differ.');
  return { path, raw: projection, entryRaw: raw };
}
