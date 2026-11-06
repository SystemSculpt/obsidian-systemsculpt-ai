import { TFile, normalizePath, type App } from 'obsidian';
import { assertValidObsidianBasesYaml } from '../../utils/obsidianBasesYaml';
import { assertValidStudioProjectAgentFileMutation, isStudioProjectDocumentPath } from '../../studio/StudioProjectAgentFileGuard';
import { applyFileEdits, FileEditApplicationError } from './editApplication';
import { planFileWrite } from './fileMutationPlan';
import { resolveExistingVaultFile } from './folderNotes';
import { FILESYSTEM_LIMITS } from './constants';
import { adapterPathExists, isHiddenSystemPath, normalizeLineEndings, normalizeVaultPath, portableVaultPathNotice, readAdapterText, resolvePortableVaultPath, validatePath } from './utils';
import type { EditFileParams, MultiEditParams, SkippedEdit, WriteFileParams } from './types';

type MutationMode = 'overwrite' | 'append' | 'edit' | 'multi_edit';
export type PreparedVaultMutation = {
  path: string;
  requestedPath?: string;
  notice?: string;
  file: TFile | null;
  adapterBacked: boolean;
  exists: boolean;
  rawOriginal?: string;
  original: string;
  modified: string;
  disposition: 'write' | 'skip';
  mode: MutationMode;
  requestedCount: number;
  appliedCount: number;
  skipped: SkippedEdit[];
  failure?: { error: unknown; status: 'missing' | 'unmatched' | 'unavailable' };
};

function emptyMutation(path: string, mode: MutationMode, requestedCount = 0): PreparedVaultMutation {
  return { path, file: null, adapterBacked: false, exists: false, original: '', modified: '', disposition: 'write', mode, requestedCount, appliedCount: 0, skipped: [] };
}

/** Read-only admission shared by hosted previews and execution. It never grants permission or writes bytes. */
export class VaultMutationPreparation {
  constructor(private readonly app: App, private readonly allowedPaths: string[] = ['/']) {}

  async write(params: WriteFileParams, includeBefore = false): Promise<PreparedVaultMutation> {
    const prepared = emptyMutation(params.path, 'overwrite');
    try {
      this.assertAllowed(params.path);
      if (params.content.length > FILESYSTEM_LIMITS.MAX_CONTENT_SIZE) {
        throw new Error(`Content too large (${params.content.length} characters). Maximum allowed is ${FILESYSTEM_LIMITS.MAX_CONTENT_SIZE} characters`);
      }
      await this.resolveTarget(prepared, params.path, 'write');
      const policy = params.ifExists ?? 'overwrite';
      // Ordinary overwrites and skips still work without reading the old file.
      // Previews request before-content; append and Studio admission require it.
      const requiresContent = policy === 'append' || (policy !== 'skip' && policy !== 'error' && isStudioProjectDocumentPath(prepared.path));
      if (prepared.exists && (includeBefore || requiresContent)) await this.read(prepared, false);
      prepared.mode = prepared.exists && policy === 'append' ? 'append' : 'overwrite';
      const plan = planFileWrite({ path: prepared.path, exists: prepared.exists, currentContent: prepared.rawOriginal,
        content: params.content, ifExists: policy, appendNewline: params.appendNewline });
      prepared.disposition = plan.disposition;
      prepared.modified = plan.disposition === 'skip' ? prepared.original : plan.modifiedContent;
      if (plan.disposition !== 'skip') this.validateContent(prepared);
    } catch (error) {
      prepared.failure = { error, status: 'unavailable' };
    }
    return prepared;
  }

  async edit(params: EditFileParams, mode: 'edit' | 'multi_edit' = 'edit'): Promise<PreparedVaultMutation> {
    const prepared = emptyMutation(params.path, mode, Array.isArray(params.edits) ? params.edits.length : 0);
    try {
      this.assertAllowed(params.path);
      const normalized = normalizePath(normalizeVaultPath(params.path));
      // Reject private Studio paths before reading, as execution always has.
      assertValidStudioProjectAgentFileMutation({ path: normalized, exists: true, mode });
      await this.resolveTarget(prepared, params.path, 'edit');
      if (!prepared.exists) {
        prepared.failure = { error: new Error(`File not found: ${params.path}`), status: 'missing' };
        return prepared;
      }
      await this.read(prepared, true);
      const applied = applyFileEdits(prepared.original, params.edits, params.strict ?? true);
      prepared.modified = applied.modifiedContent;
      prepared.appliedCount = applied.appliedCount;
      prepared.skipped = applied.skipped;
      if (mode === 'multi_edit' && (applied.appliedCount === 0 || prepared.modified === prepared.original)) {
        throw new Error('No edits applied during preflight.');
      }
      if (mode === 'multi_edit' || prepared.modified !== prepared.original) this.validateContent(prepared);
    } catch (error) {
      prepared.failure = { error, status: error instanceof FileEditApplicationError ? 'unmatched' : 'unavailable' };
      prepared.appliedCount = 0;
      if (error instanceof FileEditApplicationError) prepared.skipped = [{ index: error.index, reason: error.message }];
    }
    return prepared;
  }

  async multiEdit(params: MultiEditParams): Promise<{ mutations: PreparedVaultMutation[]; preflightFailed: boolean }> {
    const files = Array.isArray(params?.files) ? params.files : [];
    if (!files.length) throw new Error("Missing required 'files'. Provide one or more file edit plans.");
    const maxFiles = FILESYSTEM_LIMITS.MAX_MULTI_EDIT_FILES ?? 20;
    if (files.length > maxFiles) throw new Error(`Cannot edit more than ${maxFiles} files at once.`);
    const seen = new Set<string>();
    const mutations: PreparedVaultMutation[] = [];
    for (const entry of files) {
      const path = String(entry?.path ?? '').trim();
      let prepared: PreparedVaultMutation;
      if (!path || !Array.isArray(entry?.edits) || !entry.edits.length) {
        prepared = emptyMutation(path, 'multi_edit', Array.isArray(entry?.edits) ? entry.edits.length : 0);
        prepared.failure = { error: new Error('Each file requires a path and at least one edit.'), status: 'unavailable' };
      } else prepared = await this.edit({ ...entry, path }, 'multi_edit');
      // Aliases that name the same file cannot appear twice in one batch.
      if (!prepared.failure && seen.has(prepared.path)) {
        prepared.failure = { error: new Error(`Duplicate file in multi_edit: ${path}`), status: 'unavailable' };
      }
      seen.add(prepared.path);
      mutations.push(prepared);
    }
    const preflightFailed = mutations.some(prepared => prepared.failure);
    if (preflightFailed) {
      for (const prepared of mutations) {
        if (!prepared.failure) prepared.failure = { error: new Error('Not applied because another file failed preflight.'), status: 'unavailable' };
      }
    }
    return { mutations, preflightFailed };
  }

  private assertAllowed(path: string): void {
    if (!validatePath(path, this.allowedPaths)) throw new Error(`Access denied: ${path}`);
  }

  private async resolveTarget(prepared: PreparedVaultMutation, requested: string, operation: 'write' | 'edit'): Promise<void> {
    const normalized = normalizePath(normalizeVaultPath(requested));
    if (operation === 'write') {
      prepared.path = isHiddenSystemPath(normalized) || this.app.vault.getAbstractFileByPath(normalized) instanceof TFile
        ? normalized : resolvePortableVaultPath(this.app, normalized);
      this.assertAllowed(prepared.path);
      if (prepared.path !== normalized) {
        prepared.requestedPath = normalized;
        prepared.notice = portableVaultPathNotice(normalized, prepared.path);
      }
      const direct = this.app.vault.getAbstractFileByPath(prepared.path);
      prepared.file = direct instanceof TFile ? direct : null;
      prepared.adapterBacked = !prepared.file && isHiddenSystemPath(prepared.path);
    } else {
      prepared.path = normalized;
      prepared.adapterBacked = isHiddenSystemPath(normalized);
      prepared.file = prepared.adapterBacked ? null : resolveExistingVaultFile(this.app, normalized);
      if (prepared.file) prepared.path = prepared.file.path;
    }
    prepared.exists = prepared.file !== null || (prepared.adapterBacked && await adapterPathExists(this.app.vault.adapter, prepared.path));
  }

  private async read(prepared: PreparedVaultMutation, normalize: boolean): Promise<void> {
    prepared.rawOriginal = prepared.file ? await this.app.vault.read(prepared.file) : await readAdapterText(this.app.vault.adapter, prepared.path);
    prepared.original = normalize ? normalizeLineEndings(prepared.rawOriginal) : prepared.rawOriginal;
    prepared.modified = prepared.original;
  }

  private validateContent(prepared: PreparedVaultMutation): void {
    assertValidStudioProjectAgentFileMutation({ path: prepared.path, content: prepared.modified,
      previousContent: prepared.mode === 'append' ? undefined : prepared.original,
      exists: prepared.exists, mode: prepared.mode });
    if (prepared.path.toLowerCase().endsWith('.base')) assertValidObsidianBasesYaml(prepared.path, prepared.modified);
  }
}
