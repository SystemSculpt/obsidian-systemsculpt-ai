import { App, TFile, Notice } from "obsidian";
import { DocumentProcessingService } from "./DocumentProcessingService";
import { LicenseChecker } from "../core/license/LicenseChecker";
import type SystemSculptPlugin from "../main";
import { DocumentProcessingProgressEvent } from "../types/documentProcessing";
import {
  isAudioFileExtension,
  isDocumentFileExtension,
  normalizeFileExtension,
} from "../constants/fileTypes";
import { TranscriptionService } from "./TranscriptionService";
import { TranscriptionProgressManager } from "./TranscriptionProgressManager";
import { TranscriptionTitleService } from "./transcription/TranscriptionTitleService";

export interface ChatContextManager {
  getContextFiles: () => Set<string>;
  hasContextFile: (wikiLink: string) => boolean;
  addToContextFiles: (wikiLink: string) => boolean;
  triggerContextChange: () => Promise<void>;
  updateProcessingStatus: (file: TFile, event: DocumentProcessingProgressEvent) => void;
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
   * Add a file to context
   * @param file The file to add to context
   * @param contextManager The FileContextManager to update
   * @param options Options for adding the file
   * @returns Promise<boolean> indicating success or failure
   */
  public async addFileToContext(
    file: TFile,
    contextManager: ChatContextManager,
    options: {
      showNotices?: boolean;
      saveChanges?: boolean;
    } = {}
  ): Promise<boolean> {
    const { showNotices = true, saveChanges = true } = options;
    
    
    try {
      // Check license before processing
      if (!(await LicenseChecker.checkLicenseForFile(file, this.app, this.plugin))) {
        return false;
      }
      
      const extension = normalizeFileExtension(file.extension);
      
      // Determine how to process the file based on its extension
      let contextPath: string;
      
      if (isDocumentFileExtension(extension)) {
        // Process document file
        try {
          contextManager.updateProcessingStatus(file, {
            stage: "queued",
            progress: 0,
            label: "Queued for processing",
            icon: "inbox",
            flow: "document",
          });

          const extractionPath = await this.documentProcessingService.processDocument(file, {
            onProgress: (event: DocumentProcessingProgressEvent) => {
              contextManager.updateProcessingStatus(file, {
                ...event,
                flow: event.flow ?? "document",
              });
            },
            showNotices: false,
            addToContext: false,
          });

          contextManager.updateProcessingStatus(file, {
            stage: "contextualizing",
            progress: 94,
            label: "Adding extracted content to context…",
            icon: "sparkles",
            flow: "document",
          });

          // Add the markdown file to context
          const mdWikiLink = `[[${extractionPath}]]`;
          contextManager.addToContextFiles(mdWikiLink);
          
          // Find and add any images that were extracted
          await this.addExtractedImagesToContext(extractionPath, contextManager);
          
          contextPath = extractionPath;

          contextManager.updateProcessingStatus(file, {
            stage: "ready",
            progress: 100,
            label: "Document added to context",
            icon: "check-circle",
            flow: "document",
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          contextManager.updateProcessingStatus(file, {
            stage: "error",
            progress: 0,
            label: `Error: ${message}`,
            icon: "x-circle",
            flow: "document",
            error: message,
          });
          if (showNotices) {
            new Notice(`Error processing ${file.basename}: ${message}`, 5000);
          }
          return false;
        }
      } else if (isAudioFileExtension(extension)) {
        // Process audio file
        try {
          const transcriptionPath = await this.processAudioFile(file, contextManager);
          contextManager.updateProcessingStatus(file, {
            stage: "ready",
            progress: 100,
            label: "Transcription added to context",
            icon: "check-circle",
            flow: "audio",
          });
          
          // Add the transcription file to context
          const transcriptionWikiLink = `[[${transcriptionPath}]]`;
          contextManager.addToContextFiles(transcriptionWikiLink);
          
          contextPath = transcriptionPath;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          contextManager.updateProcessingStatus(file, {
            stage: "error",
            progress: 0,
            label: `Error: ${message}`,
            icon: "x-circle",
            flow: "audio",
            error: message,
          });
          if (showNotices) {
            new Notice(`Error processing ${file.basename}: ${message}`, 5000);
          }
          return false;
        }
      } else {
        // Regular file, just add it directly
        contextPath = file.path;
        const wikiLink = `[[${contextPath}]]`;
        
        // Check if file is already in context
        if (contextManager.hasContextFile(wikiLink)) {
          if (showNotices) {
            new Notice(`${file.basename} is already added to context`, 3000);
          }
          return false;
        }
        
        // Add to context
        contextManager.addToContextFiles(wikiLink);
      }
      
      // Save changes if requested
      if (saveChanges) {
        await contextManager.triggerContextChange();
      }
      
      // Show success notice if requested
      if (showNotices) {
        new Notice(`Added ${file.basename} to context`, 3000);
      }
      
      return true;
    } catch (error) {
      if (showNotices) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Error adding ${file.basename} to context: ${message}`, 5000);
      }
      return false;
    }
  }
  
  /**
   * Add extracted images to context
   * @param extractionPath The path to the extraction file
   * @param contextManager The chat context manager to update
   */
  private async addExtractedImagesToContext(
    extractionPath: string,
    contextManager: ChatContextManager
  ): Promise<void> {
    try {
      // Find and add any images that were extracted
      const extractionFile = this.app.vault.getAbstractFileByPath(extractionPath);
      if (!extractionFile) {
        return;
      }
      
      const parentFolder = extractionFile.parent;
      if (!parentFolder) {
        return;
      }
      
      // Get all files in the vault and filter for images in the parent folder
      const allFiles = this.app.vault.getAllLoadedFiles();
      const imageFiles = allFiles.filter(file => {
        // Check if it's a file (not a folder)
        if (!(file instanceof TFile)) return false;
        
        // Check if it's in a subfolder of the parent folder
        const filePath = file.path;
        if (!filePath.startsWith(parentFolder.path)) return false;
        
        // Check if it's in an images folder
        if (!filePath.includes('images-')) return false;
        
        // Check if it's an image file
        return filePath.endsWith('.png') ||
               filePath.endsWith('.jpg') ||
               filePath.endsWith('.jpeg');
      });
      
      // Add all found images to context
      for (const imageFile of imageFiles) {
        const imageWikiLink = `[[${imageFile.path}]]`;
        contextManager.addToContextFiles(imageWikiLink);
      }
      
    } catch (error) {
    }
  }
  
  /**
   * Process multiple files and add them to context
   * @param files The files to add to context
   * @param contextManager The FileContextManager to update
   * @param options Options for adding the files
   * @returns Promise<number> The number of files successfully added
   */
  public async addFilesToContext(
    files: TFile[],
    contextManager: ChatContextManager,
    options: {
      showNotices?: boolean;
      saveChanges?: boolean;
      maxFiles?: number;
    } = {}
  ): Promise<number> {
    const { showNotices = true, saveChanges = true, maxFiles = 100 } = options;
    
    
    let successCount = 0;
    let currentContextSize = contextManager.getContextFiles().size;
    
    for (const file of files) {
      // Check if we've reached the maximum number of files
      if (currentContextSize >= maxFiles) {
        if (showNotices) {
          new Notice(`File limit reached (${maxFiles} total)`, 3000);
        }
        break;
      }
      
      // Add the file to context
      const success = await this.addFileToContext(file, contextManager, {
        showNotices: false, // We'll handle notices ourselves
        saveChanges: false, // We'll save changes after all files are added
      });
      
      if (success) {
        successCount++;
        currentContextSize++;
        
        if (showNotices) {
          new Notice(`Added ${file.name} to context (${currentContextSize}/${maxFiles})`, 3000);
        }
      }
    }
    
    // Save changes if requested
    if (saveChanges) {
      await contextManager.triggerContextChange();
    }
    
    return successCount;
  }

  private mapAudioStatusToStage(status: string, progress: number): DocumentProcessingProgressEvent["stage"] {
    const normalized = status.toLowerCase();
    if (normalized.includes("error")) {
      return "error";
    }
    if (normalized.includes("upload")) {
      return "uploading";
    }
    if (normalized.includes("complete") || progress >= 100) {
      return "ready";
    }
    if (normalized.includes("context")) {
      return "contextualizing";
    }
    return "processing";
  }

  private resolveAudioIcon(status: string, fallback: string = "file-audio"): string {
    const normalized = status.toLowerCase();
    if (normalized.includes("error")) return "x-circle";
    if (normalized.includes("upload")) return "upload";
    if (normalized.includes("chunk")) return "scissors";
    if (normalized.includes("transcrib")) return "file-audio";
    if (normalized.includes("process")) return "cpu";
    if (normalized.includes("complete")) return "check-circle";
    return fallback;
  }

  private async processAudioFile(file: TFile, contextManager: ChatContextManager): Promise<string> {
    contextManager.updateProcessingStatus(file, {
      stage: "processing",
      progress: 0,
      label: "Preparing audio transcription…",
      icon: "file-audio",
      flow: "audio",
    });

    // Progress manager provides a consistent update shape + lifecycle
    const progressManager = TranscriptionProgressManager.getInstance();
    const progressHandler = progressManager.createProgressHandler(
      file,
      (progress, status, icon, details) => {
        const stage = this.mapAudioStatusToStage(status, progress);
        contextManager.updateProcessingStatus(file, {
          stage,
          progress,
          label: status,
          icon: this.resolveAudioIcon(status, icon || "file-audio"),
          flow: "audio",
          details: details || undefined,
        });
      }
    );

    const transcriptionService = TranscriptionService.getInstance(this.plugin);
    const text = await transcriptionService.transcribeFile(file, {
      ...progressHandler,
      timestamped: false,
    });

    const extractionFolder = this.plugin.settings.extractionsDirectory?.trim() || "";
    const baseName = file.basename.replace(/[\\/:*?"<>|]/g, "-").trim();
    const baseParent = extractionFolder || (file.parent?.path ?? "");
    const parentPath = baseParent ? `${baseParent}/${baseName}` : baseName;

    if (extractionFolder) {
      await this.plugin.directoryManager.ensureDirectoryByKey("extractionsDirectory");
    }
    await this.plugin.directoryManager.ensureDirectoryByPath(parentPath);

    const titleService = TranscriptionTitleService.getInstance(this.plugin);
    const fallbackBasename = titleService.buildFallbackBasename(baseName);
    const outputPath = `${parentPath}/${fallbackBasename}.md`;

    const finalContent = this.plugin.settings.cleanTranscriptionOutput
      ? text
      : `# Audio Transcription\nSource: ${file.basename}\nTranscribed: ${new Date().toISOString()}\n\n${text}`;

    const existingFile = this.app.vault.getAbstractFileByPath(outputPath);
    let transcriptionFile: TFile;
    if (existingFile instanceof TFile) {
      await this.app.vault.modify(existingFile, finalContent);
      transcriptionFile = existingFile;
    } else {
      transcriptionFile = await this.app.vault.create(outputPath, finalContent);
    }

    const finalPath = await titleService.tryRenameTranscriptionFile(this.app, transcriptionFile, {
      prefix: baseName,
      transcriptText: text,
      extension: "md",
    });

    contextManager.updateProcessingStatus(file, {
      stage: "contextualizing",
      progress: 92,
      label: "Saving transcription…",
      icon: "hard-drive",
      flow: "audio",
    });

    progressManager.handleCompletion(file.path, finalPath, () => {
      contextManager.updateProcessingStatus(file, {
        stage: "ready",
        progress: 100,
        label: "Transcription added to context",
        icon: "check-circle",
        flow: "audio",
        details: `[[${finalPath}]]`,
      });
    });

    return finalPath;
  }
}
