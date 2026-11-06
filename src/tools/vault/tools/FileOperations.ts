import { App, TFile, normalizePath } from "obsidian";
import {
  FileReadMetadata,
  ReadFilesParams,
  WriteFileParams,
  WriteFileResult,
  EditFileParams,
  EditFileResult,
  MultiEditParams,
  MultiEditResult,
  MultiEditFileResult,
} from "../types";
import { FILESYSTEM_LIMITS } from "../constants";
import {
  validatePath,
  normalizeLineEndings,
  createSimpleDiff,
  normalizeVaultPath,
  isHiddenSystemPath,
  ensureAdapterFolder,
  ensureVaultFolder,
  readAdapterText,
  writeAdapterText,
  statAdapterPath,
} from "../utils";
import { resolveExistingVaultFile } from "../folderNotes";
import { VaultMutationPreparation, type PreparedVaultMutation } from "../VaultMutationPreparation";
import { withVaultFileMutation } from "../VaultMutationSerialization";
import { isStudioProjectDocumentPath } from "../../../studio/StudioProjectAgentFileGuard";

/**
 * Raised when a file changed between the read that produced an edit and the
 * write that would apply it. Losing the other writer's bytes is worse than
 * asking the caller to re-read.
 */
const EDIT_CONFLICT_MESSAGE =
  "File changed while this edit was being prepared; nothing was overwritten. Read the file again and retry.";

/**
 * File operations for first-party vault tools (read, write, edit).
 */
export class FileOperations {
  constructor(
    private app: App,
    private allowedPaths: string[]
  ) {}

  private shouldUseAdapter(path: string): boolean {
    return isHiddenSystemPath(path);
  }

  /**
   * Atomically replace a Studio project only when it still contains the bytes
   * that were parsed and validated by the file tool. Studio can autosave while
   * an agent edit is being prepared, so a plain `modify` here could otherwise
   * overwrite that newer canvas state after validation has already finished.
   */
  /**
   * Write `nextContent` only if the file still holds `expectedContent`.
   *
   * Every edit path here reads a file, derives new content from it, then
   * writes. `vault.process` runs the comparison inside Obsidian's own file
   * lock, so a concurrent writer cannot land between the read and the write.
   */
  private async writeIfUnchanged(
    file: TFile,
    expectedContent: string,
    nextContent: string,
    conflictMessage: string
  ): Promise<void> {
    let changedBeforeWrite = false;
    await this.app.vault.process(file, (currentContent) => {
      if (currentContent !== expectedContent) {
        changedBeforeWrite = true;
        return currentContent;
      }
      return nextContent;
    });
    if (changedBeforeWrite) {
      throw new Error(conflictMessage);
    }
  }

  private async writeStudioProjectIfUnchanged(
    file: TFile,
    expectedContent: string,
    nextContent: string
  ): Promise<void> {
    await this.writeIfUnchanged(
      file,
      expectedContent,
      nextContent,
      "Studio project changed while this edit was being prepared; nothing was overwritten. Read the file again and retry."
    );
  }

  /**
   * Read multiple files with windowing support
   */
  async readFiles(params: ReadFilesParams): Promise<{ files: Array<{ path: string; content: string; metadata?: FileReadMetadata; error?: string }> }> {
    const raw = params.paths;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("Missing required 'paths'. Provide one or more file paths, e.g. {\"paths\":[\"Notes/Example.md\"]}.");
    }
    const paths = raw
      .map((v: unknown) => (typeof v === "string" ? v : String(v ?? "")))
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);
    if (paths.length === 0) {
      throw new Error("Missing required 'paths'. Provide one or more file paths, e.g. {\"paths\":[\"Notes/Example.md\"]}.");
    }

    const offset = Number(params.offset ?? 0);
    const lengthArg = params.length;
    
    // Limit number of files to prevent resource exhaustion
    const maxReadFiles = FILESYSTEM_LIMITS.MAX_READ_FILES ?? 10;
    if (paths.length > maxReadFiles) {
      throw new Error(`Too many files requested (${paths.length}). Maximum allowed is ${maxReadFiles}`);
    }
    
    // Safety: enforce per-window cap; if no length provided, default to max window
    const actualOffset = offset;
    const defaultLength = FILESYSTEM_LIMITS.MAX_FILE_READ_LENGTH;
    
    const files: Array<{ path: string; content: string; metadata?: FileReadMetadata; error?: string }> = [];
    let remainingContentBudget = Math.max(
      0,
      (FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS ?? 25000) - (paths.length * 400) - 256,
    );

    for (let pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
      const path = paths[pathIndex];
      const remainingPaths = paths.length - pathIndex;
      const fairContentShare = Math.max(0, Math.floor(remainingContentBudget / remainingPaths));
      if (!validatePath(path, this.allowedPaths)) {
        files.push({ path, content: "", error: "Access denied" });
        continue;
      }
      const normalizedPath = normalizePath(normalizeVaultPath(path));
      const file = resolveExistingVaultFile(this.app, normalizedPath);
      if (file instanceof TFile) {
        try {
          const fullContent = await this.app.vault.read(file);
          const fileSize = fullContent.length;
          
          // Calculate window boundaries
          const windowStart = Math.max(0, Math.min(actualOffset, fileSize));
          // Honor numeric strings as well as numbers
          const requestedRaw = Number(lengthArg ?? defaultLength);
          const requested = Number.isFinite(requestedRaw) && requestedRaw > 0 ? requestedRaw : defaultLength;
          const actualLength = Math.min(requested, FILESYSTEM_LIMITS.MAX_FILE_READ_LENGTH, fairContentShare);
          const windowEnd = Math.min(windowStart + actualLength, fileSize);
          let windowContent = fullContent.substring(windowStart, windowEnd);
          
          // If this read hit the max window (default or clamped) and there is more content,
          // append a clear truncation indicator with simple paging guidance.
          const lengthWasProvided = (lengthArg !== undefined && lengthArg !== null);
          const requestedRawForClampCheck = Number(lengthArg ?? defaultLength);
          const coercedRequested = Number.isFinite(requestedRawForClampCheck) && requestedRawForClampCheck > 0 ? requestedRawForClampCheck : defaultLength;
          const lengthWasClamped = coercedRequested > actualLength; // exceeded cap -> clamped
          const hasMore = windowEnd < fileSize;
          if (hasMore && (!lengthWasProvided || lengthWasClamped)) {
            const nextOffset = windowEnd;
            const notice = `\n\n[... truncated: showing ${windowStart}-${windowEnd} of ${fileSize} chars. Continue with offset=${nextOffset}]`;
            // Keep the whole payload within the transport limit by trimming the content if needed
            const MAX = FILESYSTEM_LIMITS.MAX_FILE_READ_LENGTH;
            const reserved = notice.length;
            if (windowContent.length + reserved > MAX) {
              windowContent = windowContent.slice(0, Math.max(0, MAX - reserved));
            }
            windowContent += notice;
          }
          
          // Build metadata about the read operation
          const metadata: FileReadMetadata = {
            fileSize: fileSize,
            created: new Date(file.stat.ctime).toISOString(),
            modified: new Date(file.stat.mtime).toISOString(),
            windowStart: windowStart,
            windowEnd: windowEnd,
            hasMore: hasMore
          };
          
          files.push({
            path: file.path,
            content: windowContent,
            metadata
          });
          remainingContentBudget = Math.max(0, remainingContentBudget - windowContent.length);
        } catch {
          files.push({ path, content: "", error: "Failed to read file" });
        }
      } else if (this.shouldUseAdapter(normalizedPath || path)) {
        try {
          const adapter = this.app.vault.adapter;
          const fullContent = await readAdapterText(adapter, normalizedPath || path);
          const stat = await statAdapterPath(adapter, normalizedPath || path);
          const fileSize = stat?.size ?? fullContent.length;

          const windowStart = Math.max(0, Math.min(actualOffset, fileSize));
          const requestedRaw = Number(lengthArg ?? defaultLength);
          const requested = Number.isFinite(requestedRaw) && requestedRaw > 0 ? requestedRaw : defaultLength;
          const actualLength = Math.min(requested, FILESYSTEM_LIMITS.MAX_FILE_READ_LENGTH, fairContentShare);
          const windowEnd = Math.min(windowStart + actualLength, fileSize);
          let windowContent = fullContent.substring(windowStart, windowEnd);

          const lengthWasProvided = (lengthArg !== undefined && lengthArg !== null);
          const requestedRawForClampCheck = Number(lengthArg ?? defaultLength);
          const coercedRequested = Number.isFinite(requestedRawForClampCheck) && requestedRawForClampCheck > 0 ? requestedRawForClampCheck : defaultLength;
          const lengthWasClamped = coercedRequested > actualLength;
          const hasMore = windowEnd < fileSize;
          if (hasMore && (!lengthWasProvided || lengthWasClamped)) {
            const nextOffset = windowEnd;
            const notice = `\n\n[... truncated: showing ${windowStart}-${windowEnd} of ${fileSize} chars. Continue with offset=${nextOffset}]`;
            const MAX = FILESYSTEM_LIMITS.MAX_FILE_READ_LENGTH;
            const reserved = notice.length;
            if (windowContent.length + reserved > MAX) {
              windowContent = windowContent.slice(0, Math.max(0, MAX - reserved));
            }
            windowContent += notice;
          }

          const metadata: FileReadMetadata = {
            fileSize: fileSize,
            created: stat?.ctime ? new Date(stat.ctime).toISOString() : new Date().toISOString(),
            modified: stat?.mtime ? new Date(stat.mtime).toISOString() : new Date().toISOString(),
            windowStart: windowStart,
            windowEnd: windowEnd,
            hasMore: windowEnd < fileSize,
          };

          files.push({
            path: normalizedPath || path,
            content: windowContent,
            metadata,
          });
          remainingContentBudget = Math.max(0, remainingContentBudget - windowContent.length);
        } catch {
          files.push({ path, content: "", error: "File not found or is a directory" });
        }
      } else {
        files.push({ path, content: "", error: "File not found or is a directory" });
      }
    }
    
    this.enforceReadResponseBudget(files);
    return { files };
  }

  /**
   * Write or overwrite a single file. An existing file is written at its exact
   * path; a new file whose requested name would not sync is created under a
   * portable name, which the result reports as `path` plus a `notice`.
   */
  async writeFile(params: WriteFileParams): Promise<WriteFileResult> {
    return withVaultFileMutation(this.app, async () => {
      const prepared = await new VaultMutationPreparation(this.app, this.allowedPaths).write(params);
      if (prepared.failure) throw prepared.failure.error;
      const result: WriteFileResult = { path: prepared.path, success: true,
        ...(prepared.requestedPath ? { requestedPath: prepared.requestedPath, notice: prepared.notice } : {}) };
      if (prepared.disposition === "skip") return result;
      if (prepared.file) {
        if (prepared.mode === "append" || isStudioProjectDocumentPath(prepared.path)) {
          await this.commitPreparedEdit(prepared);
        } else await this.app.vault.modify(prepared.file, prepared.modified);
      } else if (prepared.adapterBacked) {
        if (params.createDirs ?? true) {
          const lastSlash = prepared.path.lastIndexOf("/");
          if (lastSlash > 0) await ensureAdapterFolder(this.app.vault.adapter, prepared.path.substring(0, lastSlash));
        }
        await writeAdapterText(this.app.vault.adapter, prepared.path, prepared.modified);
      } else {
        // Build missing ancestors through the Vault API, preserving its errors.
        if (params.createDirs ?? true) {
          const lastSlash = prepared.path.lastIndexOf("/");
          if (lastSlash > 0) await ensureVaultFolder(this.app, prepared.path.substring(0, lastSlash));
        }
        await this.app.vault.create(prepared.path, prepared.modified);
      }
      return result;
    });
  }

  /**
   * Apply file edits through the direct vault tool implementation.
   *
   * Returns an honest accounting of the operation: the `diff`, how many edits
   * actually applied (`appliedCount`) out of `requestedCount`, and which were
   * `skipped` (only possible under `strict:false`). When nothing applies the
   * file is left untouched — no redundant no-op write — so the caller can tell
   * a phantom success apart from a real one. Under `strict:true` (the default) a
   * non-matching edit still throws, so behavior on the default path is unchanged.
   */
  async editFile(params: EditFileParams): Promise<EditFileResult> {
    return withVaultFileMutation(this.app, async () => {
      const prepared = await new VaultMutationPreparation(this.app, this.allowedPaths).edit(params);
      if (prepared.failure) throw prepared.failure.error;
      if (prepared.modified !== prepared.original) await this.commitPreparedEdit(prepared);
      return { diff: createSimpleDiff(prepared.original, prepared.modified, prepared.path),
        appliedCount: prepared.appliedCount, requestedCount: prepared.requestedCount, skipped: prepared.skipped };
    });
  }

  private async commitPreparedEdit(prepared: PreparedVaultMutation): Promise<void> {
    if (prepared.file) {
      if (isStudioProjectDocumentPath(prepared.path)) {
        await this.writeStudioProjectIfUnchanged(prepared.file, prepared.rawOriginal!, prepared.modified);
      } else await this.writeIfUnchanged(prepared.file, prepared.rawOriginal!, prepared.modified, EDIT_CONFLICT_MESSAGE);
    } else {
      // Preparation and commit share the adapter queue, not a pretend atomic CAS.
      await writeAdapterText(this.app.vault.adapter, prepared.path, prepared.modified);
    }
  }

  /**
   * Preflight every requested file before writing any of them. This prevents a
   * stale find-string in one file from silently leaving a half-applied batch.
   * A write-time conflict can still yield a partial result; remaining files are
   * then left untouched and reported explicitly.
   */
  async multiEditFiles(params: MultiEditParams): Promise<MultiEditResult> {
    return withVaultFileMutation(this.app, async () => {
      const { mutations, preflightFailed } = await new VaultMutationPreparation(this.app, this.allowedPaths).multiEdit(params);
      const results: MultiEditFileResult[] = mutations.map(prepared => ({
        path: prepared.path, success: !prepared.failure, appliedCount: prepared.appliedCount,
        requestedCount: prepared.requestedCount, skipped: prepared.skipped,
        ...(prepared.rawOriginal !== undefined ? { diff: createSimpleDiff(prepared.original, prepared.modified, prepared.path) } : {}),
        ...(prepared.failure ? { error: prepared.failure.error instanceof Error ? prepared.failure.error.message : String(prepared.failure.error) } : {}),
      }));
      if (preflightFailed) return { success: false, requestedFiles: mutations.length, appliedFiles: 0, preflightFailed: true, results };

      let appliedFiles = 0;
      for (let index = 0; index < mutations.length; index += 1) {
        const prepared = mutations[index];
        try {
          const current = normalizeLineEndings(prepared.file
            ? await this.app.vault.read(prepared.file)
            : await readAdapterText(this.app.vault.adapter, prepared.path));
          if (current !== prepared.original) {
            throw new Error("File changed after preflight; batch stopped before overwriting newer content.");
          }
          await this.commitPreparedEdit(prepared);
          appliedFiles += 1;
        } catch (error) {
          results[index] = { ...results[index], success: false, error: error instanceof Error ? error.message : String(error) };
          for (let remaining = index + 1; remaining < mutations.length; remaining += 1) {
            results[remaining] = { ...results[remaining], success: false, error: "Not applied because an earlier file failed during commit." };
          }
          return { success: false, requestedFiles: mutations.length, appliedFiles, preflightFailed: false, results };
        }
      }
      return { success: true, requestedFiles: mutations.length, appliedFiles, preflightFailed: false, results };
    });
  }

  private enforceReadResponseBudget(
    files: Array<{ path: string; content: string; metadata?: FileReadMetadata; error?: string }>
  ): void {
    const maxChars = FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS ?? 25000;
    let serializedLength = JSON.stringify({ files }).length;
    let guard = 0;
    while (serializedLength > maxChars && guard < files.length * 2) {
      guard += 1;
      const candidate = [...files]
        .reverse()
        .find((file) => typeof file.content === "string" && file.content.length > 0);
      if (!candidate) break;
      const overflow = serializedLength - maxChars;
      const nextLength = Math.max(0, candidate.content.length - overflow - 64);
      candidate.content = candidate.content.slice(0, nextLength);
      if (candidate.metadata) {
        candidate.metadata.windowEnd = candidate.metadata.windowStart + nextLength;
        candidate.metadata.hasMore = true;
      }
      serializedLength = JSON.stringify({ files }).length;
    }
  }

} 
