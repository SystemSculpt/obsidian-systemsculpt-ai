import { App, TFile, normalizePath } from "obsidian";
import {
  FileReadMetadata,
  ReadFilesParams,
  WriteFileParams,
  EditFileParams,
  EditFileResult,
  FileEdit,
  SkippedEdit,
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
  adapterPathExists,
  readAdapterText,
  writeAdapterText,
  statAdapterPath,
} from "../utils";
import { assertValidObsidianBasesYaml } from "../../../utils/obsidianBasesYaml";
import { resolveExistingVaultFile } from "../folderNotes";
import {
  assertValidStudioProjectAgentFileMutation,
  isStudioProjectDocumentPath,
} from "../../../studio/StudioProjectAgentFileGuard";

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
  private async writeStudioProjectIfUnchanged(
    file: TFile,
    expectedContent: string,
    nextContent: string
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
      throw new Error(
        "Studio project changed while this edit was being prepared; nothing was overwritten. Read the file again and retry."
      );
    }
  }

  /**
   * Read multiple files with windowing support
   */
  async readFiles(params: ReadFilesParams): Promise<{ files: Array<{ path: string; content: string; metadata?: FileReadMetadata; error?: string }> }> {
    const raw = (params as any)?.paths;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("Missing required 'paths'. Provide one or more file paths, e.g. {\"paths\":[\"Notes/Example.md\"]}.");
    }
    const paths = raw
      .map((v: any) => (typeof v === "string" ? v : String(v ?? "")))
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);
    if (paths.length === 0) {
      throw new Error("Missing required 'paths'. Provide one or more file paths, e.g. {\"paths\":[\"Notes/Example.md\"]}.");
    }

    const offset = Number((params as any)?.offset ?? 0);
    const lengthArg = (params as any)?.length;
    
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
        } catch (err) {
          files.push({ path, content: "", error: "Failed to read file" });
        }
      } else if (this.shouldUseAdapter(normalizedPath || path)) {
        try {
          const adapter: any = this.app.vault.adapter as any;
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
   * Write or overwrite a single file
   */
  async writeFile(params: WriteFileParams): Promise<{ path: string, success: boolean }> {
    const path = params.path;
    const content = params.content;
    const createDirs = (params as any).createDirs ?? true;
    const ifExists = (params as any).ifExists ?? "overwrite";
    const appendNewline = (params as any).appendNewline ?? false;
    
    if (!validatePath(path, this.allowedPaths)) {
      throw new Error(`Access denied: ${path}`);
    }
    
    // Limit content size to prevent memory issues
    if (content.length > FILESYSTEM_LIMITS.MAX_CONTENT_SIZE) {
      throw new Error(`Content too large (${content.length} characters). Maximum allowed is ${FILESYSTEM_LIMITS.MAX_CONTENT_SIZE} characters`);
    }
    
    const normalizedPath = normalizePath(normalizeVaultPath(path));
    const isBaseFile = normalizedPath.toLowerCase().endsWith(".base");
    const file = this.app.vault.getAbstractFileByPath(normalizedPath);

    if (file && file instanceof TFile) {
      if (ifExists === 'skip') {
        return { path: normalizedPath || path, success: true };
      }
      if (ifExists === 'error') {
        throw new Error(`File already exists: ${path}`);
      }
      if (ifExists === 'append') {
        const current = await this.app.vault.read(file);
        const newContent = current + (appendNewline && !current.endsWith('\n') ? '\n' : '') + content;
        assertValidStudioProjectAgentFileMutation({
          path: normalizedPath || path,
          content: newContent,
          exists: true,
          mode: "append",
        });
        if (isBaseFile) {
          assertValidObsidianBasesYaml(normalizedPath || path, newContent);
        }
        if (isStudioProjectDocumentPath(normalizedPath || path)) {
          await this.writeStudioProjectIfUnchanged(file, current, newContent);
        } else {
          await this.app.vault.modify(file, newContent);
        }
      } else {
        const previousContent = isStudioProjectDocumentPath(normalizedPath || path)
          ? await this.app.vault.read(file)
          : undefined;
        assertValidStudioProjectAgentFileMutation({
          path: normalizedPath || path,
          content,
          previousContent,
          exists: true,
          mode: "overwrite",
        });
        if (isBaseFile) {
          assertValidObsidianBasesYaml(normalizedPath || path, content);
        }
        if (typeof previousContent === "string") {
          await this.writeStudioProjectIfUnchanged(file, previousContent, content);
        } else {
          await this.app.vault.modify(file, content);
        }
      }
    } else if (this.shouldUseAdapter(normalizedPath)) {
      const adapter: any = this.app.vault.adapter as any;
      const exists = await adapterPathExists(adapter, normalizedPath);
      if (exists && ifExists === "skip") {
        return { path: normalizedPath || path, success: true };
      }
      if (exists && ifExists === "error") {
        throw new Error(`File already exists: ${path}`);
      }
      let nextContent = content;
      let previousContent: string | undefined;
      if (exists && ifExists === "append") {
        const current = await readAdapterText(adapter, normalizedPath);
        nextContent = current + (appendNewline && !current.endsWith("\n") ? "\n" : "") + content;
        previousContent = current;
      } else if (exists && isStudioProjectDocumentPath(normalizedPath || path)) {
        previousContent = await readAdapterText(adapter, normalizedPath);
      }
      assertValidStudioProjectAgentFileMutation({
        path: normalizedPath || path,
        content: nextContent,
        previousContent,
        exists,
        mode: ifExists === "append" ? "append" : "overwrite",
      });
      if (isBaseFile) {
        assertValidObsidianBasesYaml(normalizedPath || path, nextContent);
      }
      if (createDirs) {
        const lastSlash = normalizedPath.lastIndexOf("/");
        if (lastSlash > 0) {
          const folderPath = normalizedPath.substring(0, lastSlash);
          await ensureAdapterFolder(adapter, folderPath);
        }
      }
      await writeAdapterText(adapter, normalizedPath, nextContent);
    } else {
      assertValidStudioProjectAgentFileMutation({
        path: normalizedPath || path,
        content,
        exists: false,
        mode: "overwrite",
      });
      if (isBaseFile) {
        assertValidObsidianBasesYaml(normalizedPath || path, content);
      }
      // Ensure parent directories exist if requested. ensureVaultFolder builds
      // every missing ancestor through the Vault API alone and only swallows
      // "already exists", so a missing mid-level folder no longer silently
      // fails the write (#142).
      if (createDirs) {
        const lastSlash = normalizedPath.lastIndexOf('/');
        if (lastSlash > 0) {
          const folderPath = normalizedPath.substring(0, lastSlash);
          await ensureVaultFolder(this.app, folderPath);
        }
      }
      await this.app.vault.create(normalizedPath, content);
    }
    
    return { path: normalizedPath || path, success: true };
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
    const filePath = params.path;
    const edits = params.edits;
    const strict = (params as any).strict ?? true;

    if (!validatePath(filePath, this.allowedPaths)) {
      throw new Error(`Access denied: ${filePath}`);
    }

    // Read file content and normalize line endings
    const normalizedPath = normalizePath(normalizeVaultPath(filePath));
    const isBaseFile = normalizedPath.toLowerCase().endsWith(".base");
    assertValidStudioProjectAgentFileMutation({
      path: normalizedPath || filePath,
      exists: true,
      mode: "edit",
    });
    if (this.shouldUseAdapter(normalizedPath)) {
      const adapter: any = this.app.vault.adapter as any;
      const content = normalizeLineEndings(await readAdapterText(adapter, normalizedPath));

      const { modifiedContent, appliedCount, skipped } = this.applyEdits(content, edits, strict);

      const diff = createSimpleDiff(content, modifiedContent, filePath);
      // Only write when content actually changed — skip the redundant no-op write
      // so a zero-match (strict:false) edit never touches the file's mtime.
      if (modifiedContent !== content) {
        assertValidStudioProjectAgentFileMutation({
          path: normalizedPath || filePath,
          content: modifiedContent,
          previousContent: content,
          exists: true,
          mode: "edit",
        });
        if (isBaseFile) {
          assertValidObsidianBasesYaml(normalizedPath || filePath, modifiedContent);
        }
        await writeAdapterText(adapter, normalizedPath, modifiedContent);
      }
      return { diff, appliedCount, requestedCount: edits.length, skipped };
    }

    const abstractFile = resolveExistingVaultFile(this.app, normalizedPath);
    if (!abstractFile) {
      throw new Error(`File not found: ${filePath}`);
    }
    const resolvedPath = abstractFile.path;

    const originalContent = await this.app.vault.read(abstractFile);
    const content = normalizeLineEndings(originalContent);

    const { modifiedContent, appliedCount, skipped } = this.applyEdits(content, edits, strict);

    // Create simple diff
    const diff = createSimpleDiff(content, modifiedContent, resolvedPath);

    // Apply the changes to the file only when something actually changed.
    if (modifiedContent !== content) {
      assertValidStudioProjectAgentFileMutation({
        path: resolvedPath,
        content: modifiedContent,
        previousContent: content,
        exists: true,
        mode: "edit",
      });
      if (isBaseFile) {
        assertValidObsidianBasesYaml(resolvedPath, modifiedContent);
      }
      if (isStudioProjectDocumentPath(resolvedPath)) {
        await this.writeStudioProjectIfUnchanged(
          abstractFile,
          originalContent,
          modifiedContent
        );
      } else {
        await this.app.vault.modify(abstractFile, modifiedContent);
      }
    }

    return { diff, appliedCount, requestedCount: edits.length, skipped };
  }

  /**
   * Preflight every requested file before writing any of them. This prevents a
   * stale find-string in one file from silently leaving a half-applied batch.
   * A write-time conflict can still yield a partial result; remaining files are
   * then left untouched and reported explicitly.
   */
  async multiEditFiles(params: MultiEditParams): Promise<MultiEditResult> {
    const files = Array.isArray(params?.files) ? params.files : [];
    if (files.length === 0) {
      throw new Error("Missing required 'files'. Provide one or more file edit plans.");
    }
    const maxFiles = FILESYSTEM_LIMITS.MAX_MULTI_EDIT_FILES ?? 20;
    if (files.length > maxFiles) {
      throw new Error(`Cannot edit more than ${maxFiles} files at once.`);
    }

    type Plan = {
      index: number;
      path: string;
      original: string;
      modified: string;
      readCurrent: () => Promise<string>;
      write: (content: string) => Promise<void>;
      result: MultiEditFileResult;
    };

    const plans: Plan[] = [];
    const results: MultiEditFileResult[] = files.map((entry) => ({
      path: String(entry?.path ?? ""),
      success: false,
      appliedCount: 0,
      requestedCount: Array.isArray(entry?.edits) ? entry.edits.length : 0,
      skipped: [],
    }));
    const seen = new Set<string>();

    for (let index = 0; index < files.length; index += 1) {
      const entry = files[index];
      const path = String(entry?.path ?? "").trim();
      try {
        if (!path || !Array.isArray(entry?.edits) || entry.edits.length === 0) {
          throw new Error("Each file requires a path and at least one edit.");
        }
        if (!validatePath(path, this.allowedPaths)) {
          throw new Error(`Access denied: ${path}`);
        }
        const normalizedPath = normalizePath(normalizeVaultPath(path));
        assertValidStudioProjectAgentFileMutation({
          path: normalizedPath || path,
          exists: true,
          mode: "multi_edit",
        });
        if (seen.has(normalizedPath)) {
          throw new Error(`Duplicate file in multi_edit: ${path}`);
        }
        seen.add(normalizedPath);

        let original: string;
        let resolvedPath = normalizedPath;
        let readCurrent: () => Promise<string>;
        let write: (content: string) => Promise<void>;
        if (this.shouldUseAdapter(normalizedPath)) {
          const adapter: any = this.app.vault.adapter as any;
          original = normalizeLineEndings(await readAdapterText(adapter, normalizedPath));
          readCurrent = async () => normalizeLineEndings(await readAdapterText(adapter, normalizedPath));
          write = async (content) => writeAdapterText(adapter, normalizedPath, content);
        } else {
          const file = resolveExistingVaultFile(this.app, normalizedPath);
          if (!file) throw new Error(`File not found: ${path}`);
          resolvedPath = file.path;
          original = normalizeLineEndings(await this.app.vault.read(file));
          readCurrent = async () => normalizeLineEndings(await this.app.vault.read(file));
          write = isStudioProjectDocumentPath(resolvedPath)
            ? async (content) => this.writeStudioProjectIfUnchanged(file, original, content)
            : async (content) => this.app.vault.modify(file, content);
        }

        const strict = entry.strict ?? true;
        const applied = this.applyEdits(original, entry.edits, strict);
        if (applied.appliedCount === 0 || applied.modifiedContent === original) {
          throw new Error("No edits applied during preflight.");
        }
        if (resolvedPath.toLowerCase().endsWith(".base")) {
          assertValidObsidianBasesYaml(resolvedPath, applied.modifiedContent);
        }
        assertValidStudioProjectAgentFileMutation({
          path: resolvedPath,
          content: applied.modifiedContent,
          previousContent: original,
          exists: true,
          mode: "multi_edit",
        });
        const result: MultiEditFileResult = {
          path: resolvedPath,
          success: true,
          appliedCount: applied.appliedCount,
          requestedCount: entry.edits.length,
          skipped: applied.skipped,
          diff: createSimpleDiff(original, applied.modifiedContent, resolvedPath),
        };
        results[index] = result;
        plans.push({
          index,
          path: resolvedPath,
          original,
          modified: applied.modifiedContent,
          readCurrent,
          write,
          result,
        });
      } catch (error) {
        results[index] = {
          ...results[index],
          path: path || results[index].path,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (plans.length !== files.length) {
      for (const plan of plans) {
        results[plan.index] = {
          ...plan.result,
          success: false,
          error: "Not applied because another file failed preflight.",
        };
      }
      return {
        success: false,
        requestedFiles: files.length,
        appliedFiles: 0,
        preflightFailed: true,
        results,
      };
    }

    let appliedFiles = 0;
    for (let planIndex = 0; planIndex < plans.length; planIndex += 1) {
      const plan = plans[planIndex];
      try {
        const current = await plan.readCurrent();
        if (current !== plan.original) {
          throw new Error("File changed after preflight; batch stopped before overwriting newer content.");
        }
        await plan.write(plan.modified);
        appliedFiles += 1;
      } catch (error) {
        results[plan.index] = {
          ...plan.result,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        for (const remaining of plans.slice(planIndex + 1)) {
          results[remaining.index] = {
            ...remaining.result,
            success: false,
            error: "Not applied because an earlier file failed during commit.",
          };
        }
        return {
          success: false,
          requestedFiles: files.length,
          appliedFiles,
          preflightFailed: false,
          results,
        };
      }
    }

    return {
      success: true,
      requestedFiles: files.length,
      appliedFiles,
      preflightFailed: false,
      results,
    };
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

  /**
   * Apply a list of edits sequentially, counting successes and collecting any
   * skipped edits. Shared by the adapter fast-path and the Vault-API path so
   * both report identically. Under `strict:true` a non-matching edit rethrows;
   * under `strict:false` it is recorded in `skipped` and the loop continues.
   */
  private applyEdits(
    content: string,
    edits: FileEdit[],
    strict: boolean
  ): { modifiedContent: string; appliedCount: number; skipped: SkippedEdit[] } {
    let modifiedContent = content;
    let appliedCount = 0;
    const skipped: SkippedEdit[] = [];

    edits.forEach((edit, index) => {
      try {
        modifiedContent = this.applySingleEdit(modifiedContent, edit);
        appliedCount++;
      } catch (e) {
        if (strict) {
          throw e;
        }
        skipped.push({
          index,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    });

    return { modifiedContent, appliedCount, skipped };
  }

  private applySingleEdit(source: string, edit: FileEdit): string {
    const text = normalizeLineEndings(source);
    const oldText = normalizeLineEndings(edit.oldText);
    const newText = normalizeLineEndings(edit.newText);
    const mode = edit.mode || 'exact';
    const preserveIndent = edit.preserveIndent !== false;

    // Constrain to range if provided
    const { sliceStart, sliceEnd } = this.computeRange(text, edit);
    const head = text.slice(0, sliceStart);
    const target = text.slice(sliceStart, sliceEnd);
    const tail = text.slice(sliceEnd);

    let replaced = target;

    if (edit.isRegex) {
      const flags = edit.flags || 'g';
      const regex = new RegExp(oldText, flags.includes('g') ? flags : flags + 'g');
      replaced = this.replaceByOccurrenceRegex(target, regex, newText, edit.occurrence ?? 'first');
    } else if (mode === 'exact') {
      replaced = this.replaceByOccurrenceString(target, oldText, newText, edit.occurrence ?? 'first');
    } else {
      // loose mode: whitespace-trim compare line-by-line
      replaced = this.replaceLoose(target, oldText, newText, preserveIndent, edit.occurrence ?? 'first');
    }

    if (replaced === target) {
      throw new Error('Edit produced no changes');
    }

    return head + replaced + tail;
  }

  private computeRange(text: string, edit: FileEdit): { sliceStart: number; sliceEnd: number } {
    const totalLength = text.length;
    const range = edit.range;
    if (!range) return { sliceStart: 0, sliceEnd: totalLength };

    const hasIndexRange = typeof range.startIndex === 'number' || typeof range.endIndex === 'number';
    const hasLineRange = typeof range.startLine === 'number' || typeof range.endLine === 'number';

    // A non-empty character range is the most precise constraint. Some models
    // populate every optional range field and emit startIndex/endIndex as 0
    // alongside a valid line range; treat that degenerate pair as absent so it
    // cannot mask the useful line constraint.
    if (hasIndexRange) {
      const startIndex = Math.max(0, Math.min(totalLength, range.startIndex ?? 0));
      const endIndex = Math.max(startIndex, Math.min(totalLength, range.endIndex ?? totalLength));
      if (endIndex > startIndex || !hasLineRange) {
        return { sliceStart: startIndex, sliceEnd: endIndex };
      }
    }

    // Line-based range
    const lines = text.split('\n');
    const startLine = Math.max(1, range.startLine ?? 1);
    const endLine = Math.max(startLine, range.endLine ?? lines.length);
    let cursor = 0;
    let sliceStart = 0;
    let sliceEnd = totalLength;
    for (let i = 1; i <= lines.length; i++) {
      const line = lines[i - 1];
      const next = cursor + line.length + (i < lines.length ? 1 : 0);
      if (i === startLine) sliceStart = cursor;
      if (i === endLine) { sliceEnd = next; break; }
      cursor = next;
    }
    return { sliceStart, sliceEnd };
  }

  private replaceByOccurrenceString(target: string, find: string, replacement: string, occurrence: 'first' | 'last' | 'all'): string {
    if (occurrence === 'all') {
      return target.split(find).join(replacement);
    }
    if (occurrence === 'first') {
      const idx = target.indexOf(find);
      if (idx === -1) return target;
      return target.slice(0, idx) + replacement + target.slice(idx + find.length);
    }
    if (occurrence === 'last') {
      const idx = target.lastIndexOf(find);
      if (idx === -1) return target;
      return target.slice(0, idx) + replacement + target.slice(idx + find.length);
    }
    return target;
  }

  private replaceByOccurrenceRegex(target: string, pattern: RegExp, replacement: string, occurrence: 'first' | 'last' | 'all'): string {
    if (occurrence === 'all') {
      return target.replace(pattern, replacement);
    }
    const matches = Array.from(target.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')));
    if (matches.length === 0) return target;
    let which = 0;
    if (occurrence === 'first') which = 0; else if (occurrence === 'last') which = matches.length - 1;
    const m = matches[which];
    const start = m.index as number;
    const end = start + m[0].length;
    return target.slice(0, start) + m[0].replace(new RegExp(pattern.source, pattern.flags.replace('g','')), replacement) + target.slice(end);
  }

  private replaceLoose(target: string, oldText: string, newText: string, preserveIndent: boolean, occurrence: 'first' | 'last' | 'all'): string {
    const oldLines = oldText.split('\n');
    const tgtLines = target.split('\n');
    const windows: number[] = [];
    for (let i = 0; i <= tgtLines.length - oldLines.length; i++) {
      const window = tgtLines.slice(i, i + oldLines.length);
      const match = oldLines.every((l, idx) => l.trim() === (window[idx] ?? '').trim());
      if (match) windows.push(i);
    }
    if (windows.length === 0) return target;
    const replaceAt = (pos: number) => {
      const originalIndent = tgtLines[pos].match(/^\s*/)?.[0] || '';
      const newLines = newText.split('\n').map((line, j) => {
        if (!preserveIndent) return line;
        if (j === 0) return originalIndent + line.trimStart();
        return originalIndent + line.trimStart();
      });
      tgtLines.splice(pos, oldLines.length, ...newLines);
    };
    if (occurrence === 'all') {
      // Apply from last to first to keep indices stable
      for (let k = windows.length - 1; k >= 0; k--) replaceAt(windows[k]);
    } else {
      let indexToUse = 0;
      if (occurrence === 'last') indexToUse = windows.length - 1;
      replaceAt(windows[indexToUse]);
    }
    return tgtLines.join('\n');
  }
} 
