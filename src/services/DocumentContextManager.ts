import { App, TFile, Notice } from "obsidian";
import { DocumentProcessingService } from "./DocumentProcessingService";
import type SystemSculptPlugin from "../main";
import {
  isAudioFileExtension,
  isAutoDocumentConversionFileExtension,
  isUnsupportedOfficeFileExtension,
  normalizeFileExtension,
} from "../constants/fileTypes";
import { TranscriptionService } from "./TranscriptionService";
import { TranscriptionTitleService } from "./transcription/TranscriptionTitleService";
import { toSafeVaultFileName } from "../utils/vaultFileName";
import {
  createLocalCommitReceipt,
  verifyLocalCommitReceipt,
} from "./transcription/LocalCommitReceipt";

export interface ChatContextManager {
  getPinnedFiles: () => ReadonlySet<string>;
  hasPinnedFile: (fileOrWikiLink: string) => boolean;
  pinFile: (fileOrWikiLink: string) => boolean;
  triggerContextChange: () => Promise<void>;
}

export interface DocumentConversionContextEffect {
  effectId: string;
  operationId: string;
  outputIdentity: string;
  outputPath: string;
  markdownSha256: string;
  signal?: AbortSignal;
}

export type DocumentConversionContextEffectResult = "applied" | "already_applied" | "repaired";

interface PersistedDocumentContextEffect {
  operationId: string;
  outputIdentity: string;
  outputPath: string;
  markdownSha256: string;
  projectionMutated: boolean;
  notificationAcknowledged: boolean;
}

/**
 * Earlier releases kept this ledger under one key in data.json. SettingsManager
 * also writes data.json from an in-memory copy loaded at startup, so any entry
 * recorded after load was wiped by the next settings save. The ledger now owns
 * its own vault file; the legacy key is imported once and never written back.
 */
const LEGACY_DOCUMENT_CONTEXT_EFFECTS_KEY = "managedDocumentContextEffectsV1";
const DOCUMENT_CONTEXT_EFFECTS_DIR = ".systemsculpt/document-context";
const DOCUMENT_CONTEXT_EFFECTS_PATH = `${DOCUMENT_CONTEXT_EFFECTS_DIR}/effects.json`;
const DOCUMENT_CONTEXT_EFFECTS_SCHEMA_VERSION = 1;

interface DocumentContextEffectLedgerFile {
  schemaVersion: number;
  effects: Record<string, PersistedDocumentContextEffect>;
}

/**
 * Centralized service for managing document context
 * Handles adding files to context, processing documents, and updating UI
 */
export class DocumentContextManager {
  private static instance: DocumentContextManager;
  private app: App;
  private plugin: SystemSculptPlugin;
  private documentProcessingService: DocumentProcessingService;
  // Ledger writes are read-modify-write on one vault file; serialize them so
  // concurrent effects never clobber each other's entries.
  private ledgerWriteTail: Promise<void> = Promise.resolve();
  
  private constructor(app: App, plugin: SystemSculptPlugin) {
    this.app = app;
    this.plugin = plugin;
    this.documentProcessingService = DocumentProcessingService.getInstance(app, plugin);
  }

  /**
   * Get the singleton instance of DocumentContextManager
   */
  public static getInstance(
    app: App,
    plugin: SystemSculptPlugin
  ): DocumentContextManager {
    if (!DocumentContextManager.instance) {
      DocumentContextManager.instance = new DocumentContextManager(app, plugin);
    }
    return DocumentContextManager.instance;
  }

  /**
   * Durably records and idempotently projects a document-conversion context effect.
   * Existing context APIs intentionally remain unchanged.
   */
  public async applyDocumentConversionContextEffect(
    effect: DocumentConversionContextEffect,
    contextManager: ChatContextManager
  ): Promise<DocumentConversionContextEffectResult> {
    throwIfAborted(effect.signal);
    validateContextEffect(effect);
    const ledger = await this.loadContextEffectLedger();
    throwIfAborted(effect.signal);
    const persisted = ledger[effect.effectId];
    const identity = {
      operationId: effect.operationId,
      outputIdentity: effect.outputIdentity,
      outputPath: effect.outputPath,
      markdownSha256: effect.markdownSha256,
    };
    assertContextEffectIdentity(persisted, identity);

    const wasPersisted = Boolean(persisted);
    const record: PersistedDocumentContextEffect = persisted ?? {
      ...identity,
      projectionMutated: false,
      notificationAcknowledged: false,
    };
    const persist = async () => {
      await this.persistContextEffect(effect.effectId, { ...record });
      throwIfAborted(effect.signal);
    };
    if (!persisted) await persist();

    const wikiLink = `[[${effect.outputPath}]]`;
    const linkPresent = contextManager.hasPinnedFile(wikiLink);
    if (record.projectionMutated && record.notificationAcknowledged && linkPresent) {
      return "already_applied";
    }

    if (!linkPresent) {
      throwIfAborted(effect.signal);
      contextManager.pinFile(wikiLink);
      throwIfAborted(effect.signal);
    }
    if (!record.projectionMutated || !linkPresent) {
      record.projectionMutated = true;
      // Acknowledgement belongs to the context that held the earlier link.
      // Persist the repaired projection as pending before notifying this one.
      if (!linkPresent) record.notificationAcknowledged = false;
      await persist();
    }

    if (!record.notificationAcknowledged) {
      throwIfAborted(effect.signal);
      await contextManager.triggerContextChange();
      throwIfAborted(effect.signal);
      record.notificationAcknowledged = true;
      await persist();
    }
    return wasPersisted ? "repaired" : "applied";
  }

  /**
   * Reads the ledger from its vault file (or the `.previous` checkpoint left by
   * an interrupted replace). When neither exists the legacy data.json entry is
   * imported once; data.json itself is never written from here.
   */
  private async loadContextEffectLedger(): Promise<Record<string, PersistedDocumentContextEffect>> {
    const fromFile = await this.readContextEffectLedgerFile();
    if (fromFile) return fromFile;
    return this.withLedgerWriteLock(() => this.loadContextEffectLedgerLocked());
  }

  private async loadContextEffectLedgerLocked(): Promise<Record<string, PersistedDocumentContextEffect>> {
    // Re-read under the lock: an earlier writer may have created the file.
    const fromFile = await this.readContextEffectLedgerFile();
    if (fromFile) return fromFile;
    let data: unknown = null;
    try {
      data = await this.plugin.loadData?.();
    } catch {
      return {};
    }
    const legacy = data && typeof data === "object" && !Array.isArray(data)
      ? readContextEffectLedger((data as Record<string, unknown>)[LEGACY_DOCUMENT_CONTEXT_EFFECTS_KEY])
      : {};
    if (Object.keys(legacy).length > 0) await this.writeContextEffectLedger(legacy);
    return legacy;
  }

  private async readContextEffectLedgerFile(): Promise<Record<string, PersistedDocumentContextEffect> | null> {
    for (const path of [DOCUMENT_CONTEXT_EFFECTS_PATH, `${DOCUMENT_CONTEXT_EFFECTS_PATH}.previous`]) {
      const parsed = await this.readContextEffectLedgerCandidate(path);
      if (parsed) return parsed;
    }
    return null;
  }

  private async readContextEffectLedgerCandidate(path: string): Promise<Record<string, PersistedDocumentContextEffect> | null> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) return null;
    return parseContextEffectLedgerFile(await adapter.read(path));
  }

  private async persistContextEffect(
    effectId: string,
    record: PersistedDocumentContextEffect,
  ): Promise<void> {
    await this.withLedgerWriteLock(async () => {
      const ledger = await this.loadContextEffectLedgerLocked();
      // Another conversion can establish the identity after the initial read.
      assertContextEffectIdentity(ledger[effectId], record);
      ledger[effectId] = record;
      await this.writeContextEffectLedger(ledger);
    });
  }

  private withLedgerWriteLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.ledgerWriteTail.then(task, task);
    this.ledgerWriteTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Atomic replace: write a temp file, then rename it over the ledger. Adapters
   * that refuse to rename over an existing target get the current ledger parked
   * at `.previous` (which reads fall back to) for the duration of the swap.
   */
  private async writeContextEffectLedger(
    effects: Record<string, PersistedDocumentContextEffect>,
  ): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(DOCUMENT_CONTEXT_EFFECTS_DIR))) await adapter.mkdir(DOCUMENT_CONTEXT_EFFECTS_DIR);
    const file: DocumentContextEffectLedgerFile = {
      schemaVersion: DOCUMENT_CONTEXT_EFFECTS_SCHEMA_VERSION,
      effects,
    };
    const serialized = JSON.stringify(file, null, 2);
    if (typeof adapter.rename !== "function") {
      await adapter.write(DOCUMENT_CONTEXT_EFFECTS_PATH, serialized);
      return;
    }
    const tempPath = `${DOCUMENT_CONTEXT_EFFECTS_PATH}.tmp`;
    const previousPath = `${DOCUMENT_CONTEXT_EFFECTS_PATH}.previous`;
    await adapter.write(tempPath, serialized);
    try {
      await adapter.rename(tempPath, DOCUMENT_CONTEXT_EFFECTS_PATH);
    } catch (replaceError) {
      try {
        if (await adapter.exists(DOCUMENT_CONTEXT_EFFECTS_PATH)) {
          if (await this.readContextEffectLedgerCandidate(previousPath)
            && !(await this.readContextEffectLedgerCandidate(DOCUMENT_CONTEXT_EFFECTS_PATH))) {
            // Keep the readable recovery ledger when the primary is truncated.
            await adapter.remove(DOCUMENT_CONTEXT_EFFECTS_PATH);
          } else {
            if (await adapter.exists(previousPath)) await adapter.remove(previousPath);
            await adapter.rename(DOCUMENT_CONTEXT_EFFECTS_PATH, previousPath);
          }
        }
        await adapter.rename(tempPath, DOCUMENT_CONTEXT_EFFECTS_PATH);
        if (await adapter.exists(previousPath)) await adapter.remove(previousPath);
      } catch {
        try {
          if (await adapter.exists(tempPath)) await adapter.remove(tempPath);
        } catch { /* temporary cleanup is best effort */ }
        throw replaceError;
      }
    }
  }

  /**
   * Pin a vault file so it is reread for every chat message.
   * @param file The file to pin
   * @param contextManager The FileContextManager to update
   * @param options Options for adding the file
   * @returns Promise<boolean> indicating success or failure
   */
  public async pinVaultFile(
    file: TFile,
    contextManager: ChatContextManager,
    options: {
      showNotices?: boolean;
      saveChanges?: boolean;
      /** Stops document processing, e.g. when the tool call that pins is cancelled. */
      signal?: AbortSignal;
    } = {}
  ): Promise<boolean> {
    const { showNotices = true, saveChanges = true, signal } = options;
    
    
    try {
      const extension = normalizeFileExtension(file.extension);
      if (isUnsupportedOfficeFileExtension(extension)) {
        if (showNotices) new Notice("This office file type cannot be pinned in chat.", 4000);
        return false;
      }
      
      let contextEffectCommitted = false;
      
      if (isAutoDocumentConversionFileExtension(extension)) {
        // Process document file
        try {
          await this.documentProcessingService.processDocumentWithReceipt(file, {
            showNotices: false,
            signal,
            commitContextEffect: async (effect, signal) => {
              for (const imagePath of effect.imagePaths) {
                throwIfAborted(signal);
                const imageWikiLink = `[[${imagePath}]]`;
                if (!contextManager.hasPinnedFile(imageWikiLink)) contextManager.pinFile(imageWikiLink);
              }
              await this.applyDocumentConversionContextEffect({
                effectId: effect.contextEffectId,
                operationId: effect.operationId,
                outputIdentity: effect.outputIdentity,
                outputPath: effect.extractionPath,
                markdownSha256: effect.markdownSha256,
                signal,
              }, contextManager);
              contextEffectCommitted = true;
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (showNotices) {
            new Notice(`Error processing ${file.basename}: ${message}`, 5000);
          }
          return false;
        }
      } else if (isAudioFileExtension(extension)) {
        // Process audio file
        try {
          const transcriptionPath = await this.processAudioFile(file);
          
          // Add the transcription file to context
          const transcriptionWikiLink = `[[${transcriptionPath}]]`;
          contextManager.pinFile(transcriptionWikiLink);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (showNotices) {
            new Notice(`Error processing ${file.basename}: ${message}`, 5000);
          }
          return false;
        }
      } else {
        // Regular file, just add it directly
        const wikiLink = `[[${file.path}]]`;
        
        // Check if file is already in context
        if (contextManager.hasPinnedFile(wikiLink)) {
          if (showNotices) {
            new Notice(`${file.basename} is already pinned for every message`, 3000);
          }
          return false;
        }
        
        // Add to context
        contextManager.pinFile(wikiLink);
      }
      
      // Save changes if requested
      if (saveChanges && !contextEffectCommitted) {
        await contextManager.triggerContextChange();
      }
      
      // Show success notice if requested
      if (showNotices) {
        new Notice(`Pinned ${file.basename} for every message`, 3000);
      }
      
      return true;
    } catch (error) {
      if (showNotices) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Couldn't pin ${file.basename}: ${message}`, 5000);
      }
      return false;
    }
  }

  /**
   * Process and pin multiple vault files.
   * @param files The files to pin
   * @param contextManager The FileContextManager to update
   * @param options Options for adding the files
   * @returns Promise<number> The number of files successfully added
   */
  public async pinVaultFiles(
    files: TFile[],
    contextManager: ChatContextManager,
    options: {
      showNotices?: boolean;
      saveChanges?: boolean;
      maxFiles?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<number> {
    const { showNotices = true, saveChanges = true, maxFiles = 100, signal } = options;
    
    
    let successCount = 0;
    let currentContextSize = contextManager.getPinnedFiles().size;
    
    for (const file of files) {
      if (signal?.aborted) break;
      // Check if we've reached the maximum number of files
      if (currentContextSize >= maxFiles) {
        if (showNotices) {
          new Notice(`File limit reached (${maxFiles} total)`, 3000);
        }
        break;
      }
      
      // Pin the file
      const success = await this.pinVaultFile(file, contextManager, {
        showNotices: false, // We'll handle notices ourselves
        saveChanges: false, // We'll save changes after all files are added
        signal,
      });
      
      if (success) {
        successCount++;
        currentContextSize++;
        
        if (showNotices) {
          new Notice(`Pinned ${file.name} for every message (${currentContextSize}/${maxFiles})`, 3000);
        }
      }
    }
    
    // Save changes if requested
    if (saveChanges) {
      await contextManager.triggerContextChange();
    }
    
    return successCount;
  }

  private async processAudioFile(file: TFile): Promise<string> {
    const transcriptionService = TranscriptionService.getInstance(this.plugin);
    const finalPath = await transcriptionService.transcribeFile<string>(
      file,
      {
        type: "note",
        callerScope: "document-context/audio-extraction",
        timestamped: false,
        recoveryVariant: JSON.stringify({
          schema: "document-context-audio-v2",
          cleanOutput: this.plugin.settings.cleanTranscriptionOutput,
        }),
        recoverLocalCommit: async (receipt) => (
          await verifyLocalCommitReceipt(this.app, receipt)
        ).file.path,
      },
      async (text, operationId) => {
        const extractionFolder = this.plugin.settings.extractionsDirectory?.trim() || "";
        const baseName = toSafeVaultFileName(file.basename, { replacement: "-", fallback: "audio" });
        const baseParent = extractionFolder || (file.parent?.path ?? "");
        const parentPath = baseParent ? `${baseParent}/${baseName}` : baseName;

        if (extractionFolder) {
          await this.plugin.directoryManager.ensureDirectoryByKey("extractionsDirectory");
        }
        await this.plugin.directoryManager.ensureDirectoryByPath(parentPath);

        const titleService = TranscriptionTitleService.getInstance(this.plugin);
        const fallbackBasename = titleService.buildFallbackBasename(baseName);
        const finalContent = this.plugin.settings.cleanTranscriptionOutput
          ? text
          : `# Audio transcription\nSource: ${file.basename}\nTranscribed: ${new Date().toISOString()}\n\n${text}`;
        const marker = this.plugin.settings.cleanTranscriptionOutput
          ? null
          : `<!-- systemsculpt-context-transcription:${operationId} -->`;
        const storedContent = marker ? `${finalContent.trimEnd()}\n\n${marker}\n` : finalContent;
        const existing = await this.findCommittedTranscriptionFile(
          parentPath,
          storedContent,
          marker,
        );
        if (existing) {
          return {
            value: existing.path,
            receipt: createLocalCommitReceipt(existing.path, storedContent, marker),
          };
        }
        const transcriptionFile = await this.createUniqueTranscriptionFile(
          parentPath,
          fallbackBasename,
          storedContent,
        );

        const finalPath = await titleService.tryRenameTranscriptionFile(this.app, transcriptionFile, {
          prefix: baseName,
          transcriptText: text,
          extension: "md",
        });
        return {
          value: finalPath,
          receipt: createLocalCommitReceipt(finalPath, storedContent, marker),
        };
      },
    );

    return finalPath;
  }

  private async createUniqueTranscriptionFile(
    parentPath: string,
    fallbackBasename: string,
    content: string,
  ): Promise<TFile> {
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const basename = attempt === 1
        ? fallbackBasename
        : `${fallbackBasename} (${attempt})`;
      const candidate = `${parentPath}/${basename}.md`;
      if (this.app.vault.getAbstractFileByPath(candidate)) continue;
      try {
        return await this.app.vault.create(candidate, content);
      } catch (error) {
        if (!this.app.vault.getAbstractFileByPath(candidate)) throw error;
      }
    }
    throw new Error("Could not allocate a unique transcription output path.");
  }

  private async findCommittedTranscriptionFile(
    parentPath: string,
    content: string,
    marker: string | null,
  ): Promise<TFile | null> {
    const candidates = this.app.vault.getFiles().filter((candidate) => (
      candidate.extension === "md"
      && (candidate.parent?.path ?? "") === parentPath
    ));
    for (const candidate of candidates) {
      const existing = await this.app.vault.read(candidate);
      if (marker ? existing.includes(marker) : existing === content) {
        return candidate;
      }
    }
    return null;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function validateContextEffect(effect: DocumentConversionContextEffect): void {
  if (
    !/^[a-f0-9]{64}$/.test(effect.effectId) ||
    !effect.operationId ||
    !effect.outputIdentity ||
    !effect.outputPath ||
    !/^[a-f0-9]{64}$/.test(effect.markdownSha256)
  ) {
    throw new Error("Invalid document context effect.");
  }
}

function assertContextEffectIdentity(
  persisted: PersistedDocumentContextEffect | undefined,
  identity: Pick<PersistedDocumentContextEffect, "operationId" | "outputIdentity" | "outputPath" | "markdownSha256">,
): void {
  if (persisted && (
    persisted.operationId !== identity.operationId ||
    persisted.outputIdentity !== identity.outputIdentity ||
    persisted.outputPath !== identity.outputPath ||
    persisted.markdownSha256 !== identity.markdownSha256
  )) {
    throw new Error("Document context effect identity conflict.");
  }
}

function readContextEffectLedger(value: unknown): Record<string, PersistedDocumentContextEffect> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, PersistedDocumentContextEffect>) };
}

function parseContextEffectLedgerFile(raw: string): Record<string, PersistedDocumentContextEffect> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const file = parsed as Partial<DocumentContextEffectLedgerFile>;
    if (typeof file.schemaVersion !== "number") return null;
    return readContextEffectLedger(file.effects);
  } catch {
    return null;
  }
}
