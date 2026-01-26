import { App, TFile, TFolder, normalizePath } from "obsidian";
import { FileReadMetadata, ReadFilesParams, WriteFileParams, EditFileParams, FileEdit } from "../types";
import { FILESYSTEM_LIMITS } from "../constants";
import {
  validatePath,
  normalizeLineEndings,
  createSimpleDiff,
  normalizeVaultPath,
  isHiddenSystemPath,
  ensureAdapterFolder,
  adapterPathExists,
  readAdapterText,
  writeAdapterText,
  statAdapterPath,
} from "../utils";

/**
 * File operations for MCP Filesystem tools (read, write, edit)
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
    if (paths.length > FILESYSTEM_LIMITS.MAX_OPERATIONS) {
      throw new Error(`Too many files requested (${paths.length}). Maximum allowed is ${FILESYSTEM_LIMITS.MAX_OPERATIONS}`);
    }
    
    // Safety: enforce per-window cap; if no length provided, default to max window
    const actualOffset = offset;
    const defaultLength = FILESYSTEM_LIMITS.MAX_FILE_READ_LENGTH;
    
    const files: Array<{ path: string; content: string; metadata?: FileReadMetadata; error?: string }> = [];

    for (const path of paths) {
      if (!validatePath(path, this.allowedPaths)) {
        files.push({ path, content: "", error: "Access denied" });
        continue;
      }
      const normalizedPath = normalizePath(normalizeVaultPath(path));
      const file = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (file instanceof TFile) {
        try {
          const fullContent = await this.app.vault.read(file);
          const fileSize = fullContent.length;
          
          // Calculate window boundaries
          const windowStart = Math.max(0, Math.min(actualOffset, fileSize));
          // Honor numeric strings as well as numbers
          const requestedRaw = Number(lengthArg ?? defaultLength);
          const requested = Number.isFinite(requestedRaw) && requestedRaw > 0 ? requestedRaw : defaultLength;
          const actualLength = Math.min(requested, FILESYSTEM_LIMITS.MAX_FILE_READ_LENGTH);
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
            path: normalizedPath || path, 
            content: windowContent,
            metadata
          });
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
          const actualLength = Math.min(requested, FILESYSTEM_LIMITS.MAX_FILE_READ_LENGTH);
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
        } catch {
          files.push({ path, content: "", error: "File not found or is a directory" });
        }
      } else {
        files.push({ path, content: "", error: "File not found or is a directory" });
      }
    }
    
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
        await this.app.vault.modify(file, newContent);
      } else {
        await this.app.vault.modify(file, content);
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
      if (createDirs) {
        const lastSlash = normalizedPath.lastIndexOf("/");
        if (lastSlash > 0) {
          const folderPath = normalizedPath.substring(0, lastSlash);
          await ensureAdapterFolder(adapter, folderPath);
        }
      }
      let nextContent = content;
      if (exists && ifExists === "append") {
        const current = await readAdapterText(adapter, normalizedPath);
        nextContent = current + (appendNewline && !current.endsWith("\n") ? "\n" : "") + content;
      }
      await writeAdapterText(adapter, normalizedPath, nextContent);
    } else {
      // Ensure parent directories exist if requested
      if (createDirs) {
        const lastSlash = normalizedPath.lastIndexOf('/');
        if (lastSlash > 0) {
          const folderPath = normalizedPath.substring(0, lastSlash);
          try { await this.app.vault.createFolder(folderPath); } catch {}
        }
      }
      await this.app.vault.create(normalizedPath, content);
    }
    
    return { path: normalizedPath || path, success: true };
  }

  private resolveFolderNotePath(requestedPath: string): string | null {
    // Folder Notes plugin can store folder note "X" at "X/X.md".
    // We only fall back when the requested path is a markdown file and the
    // resolved target is unambiguous and already exists.
    if (!requestedPath.endsWith(".md")) return null;

    const withoutExt = requestedPath.slice(0, -3);
    if (!withoutExt) return null;

    const lastSlash = withoutExt.lastIndexOf("/");
    const noteName = lastSlash >= 0 ? withoutExt.slice(lastSlash + 1) : withoutExt;
    if (!noteName) return null;

    const folderPath = withoutExt;
    const candidatePath = `${folderPath}/${noteName}.md`;
    if (candidatePath === requestedPath) return null;

    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return null;

    const candidate = this.app.vault.getAbstractFileByPath(candidatePath);
    if (!(candidate instanceof TFile)) return null;

    return candidatePath;
  }

  /**
   * Apply file edits using the clean MCP filesystem server approach
   */
  async editFile(params: EditFileParams): Promise<string> {
    const filePath = params.path;
    const edits = params.edits;
    const strict = (params as any).strict ?? true;

    // Read file content and normalize line endings
    const normalizedPath = normalizePath(normalizeVaultPath(filePath));
    if (this.shouldUseAdapter(normalizedPath)) {
      const adapter: any = this.app.vault.adapter as any;
      const content = normalizeLineEndings(await readAdapterText(adapter, normalizedPath));

      let modifiedContent = content;
      for (const edit of edits) {
        try {
          modifiedContent = this.applySingleEdit(modifiedContent, edit);
        } catch (e) {
          if (strict) {
            throw e;
          }
        }
      }

      const diff = createSimpleDiff(content, modifiedContent, filePath);
      await writeAdapterText(adapter, normalizedPath, modifiedContent);
      return diff;
    }

    let resolvedPath = normalizedPath;
    let abstractFile = this.app.vault.getAbstractFileByPath(resolvedPath);
    if (!(abstractFile instanceof TFile)) {
      const fallback = this.resolveFolderNotePath(resolvedPath);
      if (fallback) {
        resolvedPath = fallback;
        abstractFile = this.app.vault.getAbstractFileByPath(resolvedPath);
      }
    }

    if (!(abstractFile instanceof TFile)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = normalizeLineEndings(await this.app.vault.read(abstractFile));

    // Apply edits sequentially
    let modifiedContent = content;
    for (const edit of edits) {
      try {
        modifiedContent = this.applySingleEdit(modifiedContent, edit);
      } catch (e) {
        if (strict) {
          throw e;
        }
      }
    }

    // Create simple diff
    const diff = createSimpleDiff(content, modifiedContent, resolvedPath);

    // Apply the changes to the file
    await this.app.vault.modify(abstractFile, modifiedContent);

    return diff;
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

    // Index-based range takes priority if present
    if (typeof range.startIndex === 'number' || typeof range.endIndex === 'number') {
      const startIndex = Math.max(0, Math.min(totalLength, range.startIndex ?? 0));
      const endIndex = Math.max(startIndex, Math.min(totalLength, range.endIndex ?? totalLength));
      return { sliceStart: startIndex, sliceEnd: endIndex };
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
