import { App, TFile, Notice } from "obsidian";
import type SystemSculptPlugin from "../main";
import { SystemSculptService } from "./SystemSculptService";
import { SYSTEMSCULPT_API_ENDPOINTS } from "../constants/api";
import { sleep } from "../utils/helpers";
import type { HttpResponseShim } from "../utils/httpClient";
import { PlatformContext } from "./PlatformContext";
import { DOCUMENT_UPLOAD_MAX_BYTES } from "../constants/uploadLimits";
import { DocumentUploadJobsService } from "./DocumentUploadJobsService";

const STAGE_ICONS: Record<DocumentProcessingStage, string> = {
  queued: "inbox",
  validating: "shield-check",
  uploading: "upload",
  processing: "cpu",
  downloading: "download",
  contextualizing: "sparkles",
  ready: "check-circle",
  error: "x-circle",
};

const DOCUMENT_PROCESSING_STILL_RUNNING_MESSAGE =
  "Document is still processing on SystemSculpt. Please retry in about a minute.";
const DEFAULT_DOCUMENT_POLL_ATTEMPTS = 180;

type ProgressMeta = Partial<
  Pick<DocumentProcessingLogEntry, "filePath" | "fileName" | "durationMs" | "attempt" | "source">
> & {
  documentId?: string;
  metadata?: Record<string, unknown>;
};
import {
  DocumentProcessingProgressEvent,
  DocumentProcessingStage,
  DocumentProcessingFlow,
  DocumentProcessingLogEntry,
} from "../types/documentProcessing";
import { errorLogger } from "../utils/errorLogger";

// Interface for image metadata tracking
interface ImageMetadata {
  originalName: string;
  newName: string;
  path: string;
  size: number;
  documentName: string;
  timestamp: number;
}

/**
 * Centralized service for document processing across the plugin
 * Handles conversion of documents to markdown, image extraction, and context management
 */
export class DocumentProcessingService {
  private app: App;
  private plugin: SystemSculptPlugin;
  private sculptService: SystemSculptService;
  private imageMetadataLog: ImageMetadata[] = [];
  private static instance: DocumentProcessingService;

  constructor(app: App, plugin: SystemSculptPlugin) {
    this.app = app;
    this.plugin = plugin;
    // Use singleton instance instead of creating new one
    this.sculptService = SystemSculptService.getInstance(plugin);
  }

  private clampProgress(value: number | undefined): number {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return 0;
    }
    if (!Number.isFinite(value)) {
      return value > 0 ? 100 : 0;
    }
    return Math.min(100, Math.max(0, value));
  }

  private emitProgress(
    handler: ((event: DocumentProcessingProgressEvent) => void) | undefined,
    event: DocumentProcessingProgressEvent,
    meta: ProgressMeta = {},
    fallbackFlow: DocumentProcessingFlow = "document"
  ): void {
    const normalizedEvent: DocumentProcessingProgressEvent = {
      ...event,
      progress: this.clampProgress(event.progress),
      flow: event.flow ?? fallbackFlow,
    };

    try {
      handler?.(normalizedEvent);
    } catch (error) {
      errorLogger.error("Progress handler threw", error, {
        source: "DocumentProcessingService",
        method: "emitProgress",
        metadata: {
          stage: normalizedEvent.stage,
          filePath: meta.filePath,
        },
      });
    }
  }

  private mapNormalizedStatusToStage(status?: string): DocumentProcessingStage {
    switch ((status ?? "").toLowerCase()) {
      case "queued":
        return "queued";
      case "validating":
      case "preparing":
        return "validating";
      case "uploading":
        return "uploading";
      case "chunking":
      case "extracting":
      case "processing":
      case "analyzing":
      case "analysis":
        return "processing";
      case "downloading":
        return "downloading";
      case "contextualizing":
      case "integrating":
        return "contextualizing";
      case "completed":
      case "ready":
        return "ready";
      case "failed":
      case "error":
      case "timed_out":
        return "error";
      default:
        return "processing";
    }
  }

  /**
   * Get the singleton instance of DocumentProcessingService
   */
  public static getInstance(
    app: App,
    plugin: SystemSculptPlugin
  ): DocumentProcessingService {
    if (!DocumentProcessingService.instance) {
      DocumentProcessingService.instance = new DocumentProcessingService(app, plugin);
    }
    return DocumentProcessingService.instance;
  }

  /**
   * Process a document file and convert it to markdown
   * @param file The file to process
   * @param options Processing options
   * @returns Promise with the path to the extracted markdown file
   */
  /**
   * Process a document file and convert it to markdown
   * @param file The file to process
   * @param options Processing options
   * @returns Promise with the path to the extracted markdown file
   */
  public async processDocument(
    file: TFile,
    options: {
      onProgress?: (event: DocumentProcessingProgressEvent) => void;
      addToContext?: boolean;
      showNotices?: boolean;
      flow?: DocumentProcessingFlow;
    } = {}
  ): Promise<string> {
    const {
      onProgress,
      addToContext = false,
      showNotices = true,
      flow = "document",
    } = options;

    const meta: ProgressMeta = {
      filePath: file.path,
      fileName: file.name,
    };
    const startedAt = Date.now();
    let documentId: string | undefined;
    let lastStage: DocumentProcessingStage = "queued";
    let emittedError = false;

    const progressHandler = onProgress;

    try {
      this.emitProgress(
        progressHandler,
        {
          stage: "validating",
          progress: 5,
          label: "Validating license…",
          icon: STAGE_ICONS.validating,
          metadata: { startedAt },
        },
        meta,
        flow
      );

      const hasValidLicense = await this.plugin
        .getLicenseManager()
        .validateLicenseKey(true, false);
      if (!hasValidLicense) {
        throw new Error("Valid license required for document processing");
      }

      this.emitProgress(
        progressHandler,
        {
          stage: "uploading",
          progress: 15,
          label: "Uploading document to DataLab…",
          icon: STAGE_ICONS.uploading,
        },
        meta,
        flow
      );

      let uploadResult: any;
      try {
        const platform = PlatformContext.get();
        const fileSize = typeof file.stat?.size === "number" ? file.stat.size : 0;
        const shouldUseJobsUpload =
          !platform.isMobile() &&
          Number.isFinite(fileSize) &&
          fileSize > DOCUMENT_UPLOAD_MAX_BYTES;

        if (shouldUseJobsUpload) {
          const jobsUploader = new DocumentUploadJobsService(
            this.app,
            this.sculptService.baseUrl,
            this.plugin.settings.licenseKey || "",
            this.plugin.manifest?.version ?? "0.0.0"
          );

          const reservedStart = 15;
          const reservedEnd = 35;
          const reservedRange = Math.max(1, reservedEnd - reservedStart);

          uploadResult = await jobsUploader.uploadDocumentViaJobs(file, {
            onProgress: (evt) => {
              const mapped =
                reservedStart +
                Math.round((Math.max(0, Math.min(100, evt.progress)) / 100) * reservedRange);
              this.emitProgress(
                progressHandler,
                {
                  stage: "uploading",
                  progress: mapped,
                  label: evt.label,
                  icon: STAGE_ICONS.uploading,
                  metadata: {
                    uploadStage: evt.stage,
                    ...(evt.stage === "uploading"
                      ? { partNumber: evt.partNumber, totalParts: evt.totalParts }
                      : {}),
                  },
                },
                meta,
                flow
              );
            },
          });
        } else {
          uploadResult = await this.sculptService.uploadDocument(file);
        }
      } catch (uploadError) {
        const message = uploadError instanceof Error
          ? uploadError.message
          : String(uploadError);
        this.emitProgress(
          progressHandler,
          {
            stage: "error",
            progress: 0,
            label: `Upload failed: ${message}`,
            icon: STAGE_ICONS.error,
            error: message,
          },
          meta,
          flow
        );
        lastStage = "error";
        emittedError = true;
        throw uploadError;
      }

      documentId = uploadResult?.documentId;
      const cached = Boolean(uploadResult?.cached);

      if (documentId) {
        meta.documentId = documentId;
      }

      this.emitProgress(
        progressHandler,
        {
          stage: "uploading",
          progress: cached ? 45 : 35,
          label: cached ? "Upload skipped — cached extraction available" : "Upload complete, queued for processing",
          icon: cached ? "history" : "check",
          documentId,
          cached,
        },
        meta,
        flow
      );

      if (cached && documentId) {
        lastStage = "processing";
        this.emitProgress(
          progressHandler,
          {
            stage: "processing",
            progress: 55,
            label: "Reusing cached extraction results",
            icon: "archive",
            documentId,
            cached: true,
          },
          meta,
          flow
        );

        const extractionData = await this.downloadExtraction(documentId);
        this.emitProgress(
          progressHandler,
          {
            stage: "downloading",
            progress: 85,
            label: "Downloading cached results…",
            icon: STAGE_ICONS.downloading,
            documentId,
            cached: true,
          },
          meta,
          flow
        );

        const extractionPath = await this.saveExtractionResults(file, extractionData, {
          addToContext,
        });

        this.emitProgress(
          progressHandler,
          {
            stage: "downloading",
            progress: 90,
            label: "Cached results saved to vault",
            icon: "hard-drive",
            documentId,
            cached: true,
          },
          meta,
          flow
        );

        if (showNotices) {
          new Notice("Document successfully converted from cache");
        }

        meta.durationMs = Date.now() - startedAt;
        lastStage = "downloading";
        return extractionPath;
      }

      if (!documentId) {
        throw new Error("Upload did not return a document ID");
      }

      lastStage = "processing";
      const maxPollAttempts = DEFAULT_DOCUMENT_POLL_ATTEMPTS;
      const pollResult = await this.pollUntilComplete(
        documentId,
        progressHandler,
        meta,
        flow,
        maxPollAttempts
      );

      if (!pollResult.completed) {
        throw new Error(
          pollResult.error || DOCUMENT_PROCESSING_STILL_RUNNING_MESSAGE
        );
      }

      this.emitProgress(
        progressHandler,
        {
          stage: "downloading",
          progress: 85,
          label: "Downloading processed results…",
          icon: STAGE_ICONS.downloading,
          documentId,
        },
        meta,
        flow
      );

      try {
        const downloadPromise = this.downloadExtraction(documentId);
        let extractionData = await new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Download timed out")), 30000);
          downloadPromise.then(
            (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            (error) => {
              clearTimeout(timer);
              reject(error);
            }
          );
        });

        if (
          !extractionData ||
          (typeof extractionData === "object" &&
            !extractionData.content &&
            !extractionData.text &&
            !extractionData.markdown &&
            !extractionData.extraction)
        ) {
          try {
            const fallbackUrl = `${this.sculptService.baseUrl}/documents/${documentId}/raw`;
            const { httpRequest } = await import("../utils/httpClient");
            const fallbackResponse = await httpRequest({
              url: fallbackUrl,
              method: "GET",
              headers: {
                "x-license-key": this.plugin.settings.licenseKey || "",
                "x-plugin-version": this.plugin.manifest?.version ?? "0.0.0",
              },
            });

            if (fallbackResponse.status && fallbackResponse.status < 400) {
              const rawText = fallbackResponse.text || "";
              if (rawText) {
                extractionData = { content: rawText };
              }
            }
          } catch (fallbackError) {
            this.emitProgress(
              progressHandler,
              {
                stage: "processing",
                progress: 88,
                label: "Fallback download attempt failed",
                icon: "alert-triangle",
                documentId,
                details:
                  fallbackError instanceof Error
                    ? fallbackError.message
                    : String(fallbackError),
              },
              meta,
              flow
            );
          }
        }

        const extractionPath = await this.saveExtractionResults(file, extractionData, {
          addToContext,
        });

        this.emitProgress(
          progressHandler,
          {
            stage: "downloading",
            progress: 92,
            label: "Extraction saved",
            icon: "file-down",
            documentId,
          },
          meta,
          flow
        );

        if (showNotices) {
          new Notice("Document successfully converted to markdown");
        }

        meta.durationMs = Date.now() - startedAt;
        lastStage = "downloading";
        return extractionPath;
      } catch (downloadError) {
        const message =
          downloadError instanceof Error
            ? downloadError.message
            : String(downloadError);
        this.emitProgress(
          progressHandler,
          {
            stage: "error",
            progress: 0,
            label: "Error downloading results",
            icon: STAGE_ICONS.error,
            documentId,
            error: message,
            details:
              "The server might be experiencing issues. The operation will continue in the background.",
          },
          meta,
          flow
        );
        lastStage = "error";
        emittedError = true;
        throw downloadError;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!emittedError) {
        this.emitProgress(
          progressHandler,
          {
            stage: "error",
            progress: 0,
            label: `Error: ${message}`,
            icon: STAGE_ICONS.error,
            documentId,
            error: message,
          },
          meta,
          flow
        );
        lastStage = "error";
        emittedError = true;
      }

      if (showNotices) {
        new Notice(`Failed to process document: ${message}`);
      }
      throw error;
    }
  }

  /**
   * Poll for document processing completion
   * @param documentId The document ID to poll for
   * @param progressHandler Optional progress handler function
   * @param maxAttempts Maximum number of polling attempts
   * @returns Promise<boolean> indicating success or failure
   */
  private async pollUntilComplete(
    documentId: string,
    handler: ((event: DocumentProcessingProgressEvent) => void) | undefined,
    meta: ProgressMeta,
    flow: DocumentProcessingFlow,
    maxAttempts = 30
  ): Promise<{ completed: boolean; status: string; error?: string }> {
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5;
    let lastStatus = "processing";
    let lastError: string | undefined;
    const pollMeta: ProgressMeta = { ...meta, documentId };

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const baseUrl = this.sculptService.baseUrl;
        const endpoint = SYSTEMSCULPT_API_ENDPOINTS.DOCUMENTS.GET(documentId);
        const url = `${baseUrl}${endpoint}`;

        const { httpRequest } = await import("../utils/httpClient");
        const response = await httpRequest({
          url,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "x-license-key": this.plugin.settings.licenseKey || "",
            "x-plugin-version": this.plugin.manifest?.version ?? "0.0.0",
          },
        });

        if (!response.status || response.status >= 400) {
          consecutiveErrors++;
          lastError = `HTTP ${response.status}`;
          const progress = 40 + (i / maxAttempts) * 30;
          const message =
            response.status === 500
              ? "Server error, retrying…"
              : `Error ${response.status}, retrying…`;

          this.emitProgress(
            handler,
            {
              stage: "processing",
              progress,
              label: message,
              icon: "alert-triangle",
              documentId,
              details: lastError,
              metadata: { attempt: i + 1 },
            },
            { ...pollMeta, attempt: i + 1 },
            flow
          );

          if (consecutiveErrors >= maxConsecutiveErrors) {
            this.emitProgress(
              handler,
              {
                stage: "error",
                progress: 0,
                label: "Server returned repeated errors",
                icon: STAGE_ICONS.error,
                documentId,
                error: lastError,
              },
              pollMeta,
              flow
            );
            await sleep(3000);
            return {
              completed: false,
              status: lastStatus,
              error: lastError || "Server returned repeated errors",
            };
          }

          await sleep(3000);
          continue;
        }

        consecutiveErrors = 0;

        const statusInfo = this.parseDocumentStatusResponse(response);
        lastStatus = statusInfo.normalizedStatus || statusInfo.rawStatus || lastStatus;
        lastError = statusInfo.error || lastError;

        const stage = this.mapNormalizedStatusToStage(statusInfo.normalizedStatus);
        const baseProgress = Math.min(45 + (i / maxAttempts) * 45, 90);
        const progress =
          typeof statusInfo.progress === "number"
            ? Math.max(baseProgress, statusInfo.progress)
            : baseProgress;

        if (stage === "error") {
          const errorMessage =
            statusInfo.error ||
            `Document processing failed (${statusInfo.rawStatus || "unknown"})`;
          this.emitProgress(
            handler,
            {
              stage: "error",
              progress,
              label: errorMessage,
              icon: STAGE_ICONS.error,
              documentId,
              error: errorMessage,
              details: statusInfo.error,
            },
            pollMeta,
            flow
          );
          await sleep(2000);
          return {
            completed: false,
            status: statusInfo.normalizedStatus,
            error: errorMessage,
          };
        }

        if (stage === "ready") {
          this.emitProgress(
            handler,
            {
              stage: "processing",
              progress: Math.max(progress, 92),
              label: "Processing complete, finalizing…",
              icon: "check",
              documentId,
              status: statusInfo.rawStatus,
            },
            pollMeta,
            flow
          );
          return { completed: true, status: "completed" };
        }

        const label =
          stage === "queued"
            ? "Queued at document processor…"
            : "Processing document…";
        const icon = stage === "queued" ? STAGE_ICONS.queued : STAGE_ICONS.processing;

        this.emitProgress(
          handler,
          {
            stage,
            progress,
            label,
            icon,
            documentId,
            status: statusInfo.rawStatus,
            details: statusInfo.error,
            metadata: { attempt: i + 1 },
          },
          { ...pollMeta, attempt: i + 1 },
          flow
        );
      } catch (error) {
        consecutiveErrors++;
        lastError = error instanceof Error ? error.message : String(error);
        const progress = 45 + (i / maxAttempts) * 35;

        this.emitProgress(
          handler,
          {
            stage: "processing",
            progress,
            label: "Connection issue, retrying…",
            icon: "alert-triangle",
            documentId,
            details: lastError,
            metadata: { attempt: i + 1 },
          },
          { ...pollMeta, attempt: i + 1 },
          flow
        );

        if (consecutiveErrors >= maxConsecutiveErrors) {
          this.emitProgress(
            handler,
            {
              stage: "error",
              progress: 0,
              label:
                "Too many connection errors. Please check your internet connection and try again.",
              icon: STAGE_ICONS.error,
              documentId,
              error: lastError,
            },
            pollMeta,
            flow
          );
          await sleep(3000);
          return {
            completed: false,
            status: "error",
            error:
              lastError ||
              "Too many connection errors. Please check your internet connection and try again.",
          };
        }
      }

      await sleep(2000);
    }

    this.emitProgress(
      handler,
      {
        stage: "error",
        progress: 0,
        label: DOCUMENT_PROCESSING_STILL_RUNNING_MESSAGE,
        icon: "clock",
        documentId,
        error: lastError || DOCUMENT_PROCESSING_STILL_RUNNING_MESSAGE,
      },
      pollMeta,
      flow
    );
    await sleep(3000);
    return {
      completed: false,
      status: lastStatus,
      error: lastError || DOCUMENT_PROCESSING_STILL_RUNNING_MESSAGE,
    };
  }

  private parseDocumentStatusResponse(response: HttpResponseShim): {
    normalizedStatus: string;
    rawStatus: string;
    error?: string;
    progress?: number;
  } {
    let payload: any = response.json;
    if ((!payload || typeof payload !== 'object') && response.text) {
      try {
        payload = JSON.parse(response.text);
      } catch {
        payload = {};
      }
    }

    if (!payload || typeof payload !== 'object') {
      payload = {};
    }

    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    const rawStatusValue =
      (data && typeof (data as any).status === 'string' ? (data as any).status : undefined) ??
      (typeof payload.status === 'string' ? payload.status : undefined);

    const normalizedStatusValue =
      typeof (data as any).normalizedStatus === 'string'
        ? (data as any).normalizedStatus
        : rawStatusValue;

    const normalizedStatus = normalizedStatusValue
      ? normalizedStatusValue.toLowerCase()
      : 'processing';
    const rawStatus = rawStatusValue || normalizedStatusValue || 'processing';

    const errorMessage =
      typeof (data as any).error === 'string'
        ? (data as any).error
        : typeof payload.error === 'string'
        ? payload.error
        : undefined;

    const progress =
      typeof (data as any).progress === 'number' ? (data as any).progress : undefined;

    return {
      normalizedStatus,
      rawStatus,
      error: errorMessage,
      progress,
    };
  }

  /**
   * Download extraction data for a document
   * @param documentId The document ID to download extraction for
   * @returns Promise with the extraction data
   */
  private async downloadExtraction(documentId: string): Promise<any> {
    try {
      // Construct the URL with proper error handling
      const baseUrl = this.sculptService.baseUrl;
      const endpoint = SYSTEMSCULPT_API_ENDPOINTS.DOCUMENTS.DOWNLOAD(documentId);
      const url = `${baseUrl}${endpoint}`;

      const { httpRequest } = await import('../utils/httpClient');
      const response = await httpRequest({
        url,
        method: 'GET',
        headers: {
          "Content-Type": "application/json",
          "x-license-key": this.plugin.settings.licenseKey || "",
          "x-plugin-version": this.plugin.manifest?.version ?? "0.0.0",
        },
      });

      if (!response.status || response.status >= 400) {
        throw new Error(`Failed to download extraction: ${response.status}`);
      }

      const data = response.json || (response.text ? JSON.parse(response.text) : {});

      if (data && data.success === false) {
        const errorMessage =
          data.error || data.details || 'Document extraction is not ready yet.';
        throw new Error(errorMessage);
      }

      const nestedExtraction =
        (data && typeof data === 'object' && data.extractionResult)
          ? data.extractionResult
          : data?.data?.extractionResult;

      if (nestedExtraction && typeof nestedExtraction === 'object') {
        if (!data.content && nestedExtraction.markdown) {
          data.content = nestedExtraction.markdown;
        }
        if (!data.text && nestedExtraction.text) {
          data.text = nestedExtraction.text;
        }
        if (!data.markdown && nestedExtraction.markdown) {
          data.markdown = nestedExtraction.markdown;
        }
        if (!data.images && nestedExtraction.images) {
          data.images = nestedExtraction.images;
        }
        if (!data.metadata && nestedExtraction.metadata) {
          data.metadata = nestedExtraction.metadata;
        }
      }

      // Validate that we have actual content
      if (!data || (typeof data === 'object' && !data.content && !data.text)) {
        throw new Error("Empty extraction data received from server");
      }

      return data;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Save extraction results to disk and optionally add to context
   * @param file The original file
   * @param data The extraction data
   * @param options Options for saving
   * @returns Promise with the path to the saved extraction file
   */
  private async saveExtractionResults(
    file: TFile,
    data: any,
    options: {
      addToContext?: boolean;
    } = {}
  ): Promise<string> {
    const { addToContext = false } = options;

    try {

      const extractionFolder = this.sculptService.extractionsDirectory;
      const baseName = this.sanitizeFilename(file.basename);
      const parentPath = extractionFolder
        ? `${extractionFolder}/${baseName}`
        : `${file.parent?.path || ""}/${baseName}`;

      // Create the target folder using the DirectoryManager
      if (this.plugin.directoryManager) {
        await this.plugin.directoryManager.ensureDirectoryByPath(parentPath);
      } else {
        // Fallback to the legacy method
        await this.plugin.createDirectory(parentPath);
      }

      // Process and save images if present
      let processedContent = data;

      // Extract images from different possible locations in the API response
      const images = this.extractImagesFromData(data);

      if (images && Object.keys(images).length > 0) {
        // Add images to processed content for later reference
        processedContent.images = images;

        // Create a document-specific images subfolder with a deterministic name
        const documentId = this.sanitizeFilename(baseName).substring(0, 20); // Limit length
        const imagesPath = `${parentPath}/images-${documentId}`;

        // Check if the directory already exists
        const directoryExists = await this.app.vault.adapter.exists(imagesPath);

        // If it exists, we'll reuse it and clean it up
        if (directoryExists) {
          try {
            // Get all files in the directory
            const files = await this.app.vault.adapter.list(imagesPath);
            if (files && files.files && files.files.length > 0) {

              // Delete all existing files in the directory
              for (const file of files.files) {
                await this.app.vault.adapter.remove(file);
              }
            }
          } catch (error) {
            // Continue anyway - we'll try to overwrite files as needed
          }
        }

        // Create the images directory
        if (this.plugin.directoryManager) {
          await this.plugin.directoryManager.ensureDirectoryByPath(imagesPath);
        } else {
          await this.plugin.createDirectory(imagesPath);
        }

        // Create maps to track images and prevent duplicates
        const imagePathMap = new Map<string, string>();
        const processedImages = new Map<string, string>(); // Maps content hash to relative path

        // Process each image
        for (const [imageName, imageBase64] of Object.entries<string>(images)) {
          try {
            // Generate a content hash for deduplication
            const imageHash = this.simpleHash(imageBase64.substring(0, 1000));
            const existingImage = processedImages.get(imageHash);

            if (existingImage) {
              // Reuse the existing image path for duplicate images
              imagePathMap.set(imageName, existingImage);
              continue;
            }

            // Generate a deterministic name for the image to prevent collisions
            // This ensures the same image always gets the same filename
            const uniqueImageName = this.generateUniqueImageName(baseName, imageName, imageBase64);
            const imagePath = this.normalizePath(`${imagesPath}/${uniqueImageName}`);


            // Convert base64 to array buffer
            const imageArrayBuffer = this.base64ToArrayBuffer(imageBase64);

            // Verify the image data is valid
            if (imageArrayBuffer.byteLength < 100) {
            }

            // Note: We don't need to check if the image exists and remove it
            // because we've already cleaned up the directory if it existed

            // Save the image
            await this.app.vault.createBinary(imagePath, imageArrayBuffer);

            // Get the folder name from the full path
            const folderName = imagesPath.split('/').pop() || 'images';

            // Store the mapping from original image name to new path
            // Use relative path for markdown references
            const relativeImagePath = `${folderName}/${uniqueImageName}`;
            imagePathMap.set(imageName, relativeImagePath);

            // Store in processed images map for deduplication
            processedImages.set(imageHash, relativeImagePath);

            // Add metadata to track image processing
            this.recordImageMetadata({
              originalName: imageName,
              newName: uniqueImageName,
              path: imagePath,
              size: imageArrayBuffer.byteLength,
              documentName: file.basename,
              timestamp: Date.now()
            });

            // Add to context if requested
            if (addToContext) {
              // TODO: Implement context addition once we integrate with FileContextManager
            }
          } catch (imageError) {
          }
        }

        // Update image references in the content if needed
        if (processedContent.content && imagePathMap.size > 0) {
          let updatedContent = processedContent.content;

          // Replace image references in markdown content
          imagePathMap.forEach((newPath, originalName) => {
            try {
              // Escape special characters in the original name for regex
              const escapedOriginalName = originalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

              // Match various forms of image references
              const imgRegex = new RegExp(`!\\[([^\\]]*)\\]\\(${escapedOriginalName}\\)`, 'g');
              updatedContent = updatedContent.replace(imgRegex, `![$1](${newPath})`);

              // Also match image references without alt text
              const imgRegexNoAlt = new RegExp(`!\\[\\]\\(${escapedOriginalName}\\)`, 'g');
              updatedContent = updatedContent.replace(imgRegexNoAlt, `![](${newPath})`);

              // Also handle HTML img tags
              const htmlImgRegex = new RegExp(`<img[^>]*src=["']${escapedOriginalName}["'][^>]*>`, 'g');
              updatedContent = updatedContent.replace(htmlImgRegex, (match: string) => {
                return match.replace(escapedOriginalName, newPath);
              });

              // Also try to match the filename without path
              const filenameOnly = escapedOriginalName.split('/').pop();
              if (filenameOnly && filenameOnly !== escapedOriginalName) {
                const filenameRegex = new RegExp(`!\\[([^\\]]*)\\]\\(${filenameOnly}\\)`, 'g');
                updatedContent = updatedContent.replace(filenameRegex, `![$1](${newPath})`);
              }

              // Log successful replacement
            } catch (regexError) {
            }
          });

          processedContent.content = updatedContent;
        }
      }

      // Create extraction file path
      const extractionPath = this.normalizePath(
        `${parentPath}/${baseName}-extraction.md`
      );

      // Check if data is valid
      if (!processedContent) {
        throw new Error("Invalid extraction data received");
      }

      // Save the extraction content
      const content = this.formatExtractionContent(processedContent);

      const existingFile = this.app.vault.getAbstractFileByPath(extractionPath);
      if (existingFile instanceof TFile) {
        await this.app.vault.modify(existingFile, content);
      } else {
        await this.app.vault.create(extractionPath, content);
      }

      return extractionPath;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Format extraction content for display
   * @param data The extraction data
   * @returns Formatted markdown content
   */
  private formatExtractionContent(data: any): string {
    // Handle different data formats that might be returned by the API
    let title = "Document Extraction";
    let content = "";

    if (data) {
      // Handle different possible data structures
      if (data.title) {
        title = data.title;
      } else if (data.metadata && data.metadata.title) {
        title = data.metadata.title;
      } else if (data.document && data.document.title) {
        title = data.document.title;
      }

      if (data.content) {
        content = data.content;
      } else if (data.text) {
        content = data.text;
      } else if (data.document && data.document.content) {
        content = data.document.content;
      } else if (data.document && data.document.text) {
        content = data.document.text;
      } else if (typeof data === 'string') {
        content = data;
      } else if (data.markdown) {
        content = data.markdown;
      } else if (data.extraction) {
        content = data.extraction;
      }
    }

    // If content is still empty, try to use the entire data object as a string
    if (!content && data) {
      try {
        // Try to stringify the entire object if nothing else worked
        if (typeof data === 'object') {
          content = JSON.stringify(data, null, 2);
        }
      } catch (e) {
      }
    }

    // Add a note if content is still empty
    if (!content) {
      content = "No content was extracted from this document. The server may be experiencing issues or the document format is not supported.";
    }

    // Add a note about images if they were processed
    let imageNote = "";
    if (data && data.images && Object.keys(data.images).length > 0) {
      const imageCount = Object.keys(data.images).length;
      // Extract the folder name from the first image path if available
      let folderInfo = "the images folder";
      if (this.imageMetadataLog && this.imageMetadataLog.length > 0) {
        const firstImage = this.imageMetadataLog[this.imageMetadataLog.length - imageCount];
        if (firstImage && firstImage.path) {
          const pathParts = firstImage.path.split('/');
          if (pathParts.length >= 2) {
            folderInfo = `the '${pathParts[pathParts.length - 2]}' folder`;
          }
        }
      }
      imageNote = `

> [!note] Images
> ${imageCount} image${imageCount > 1 ? 's were' : ' was'} extracted from this document and saved in ${folderInfo}.
`;
    }

    return `# ${title}

${content}${imageNote}

---
Extracted with SystemSculpt
`;
  }

  /**
   * Extracts images from different possible locations in the API response
   * @param data The API response data
   * @returns Object containing image name to base64 mappings
   */
  private extractImagesFromData(data: any): Record<string, string> {
    const images: Record<string, string> = {};

    if (!data) return images;

    // Direct images object
    if (data.images && typeof data.images === 'object') {
      Object.entries(data.images).forEach(([key, value]) => {
        if (typeof value === 'string') {
          images[key] = value;
        }
      });
    }

    // Nested in document
    if (data.document && data.document.images && typeof data.document.images === 'object') {
      Object.entries(data.document.images).forEach(([key, value]) => {
        if (typeof value === 'string') {
          images[key] = value;
        }
      });
    }

    // Images in an array format
    if (data.imageList && Array.isArray(data.imageList)) {
      data.imageList.forEach((img: any, index: number) => {
        if (img && typeof img.data === 'string') {
          const name = img.name || `image-${index}.png`;
          images[name] = img.data;
        }
      });
    }

    // Images in figures array (common in some API responses)
    if (data.figures && Array.isArray(data.figures)) {
      data.figures.forEach((fig: any, index: number) => {
        if (fig && typeof fig.image === 'string') {
          const name = fig.name || `figure-${index}.png`;
          images[name] = fig.image;
        }
      });
    }

    return images;
  }

  /**
   * Generates a deterministic image filename to prevent collisions and ensure consistency
   * @param baseName Base name for the image
   * @param imageName Original image name
   * @param imageData Base64 image data (used for content-based hashing)
   * @returns A unique image filename
   */
  private generateUniqueImageName(baseName: string, imageName: string, imageData?: string): string {
    // Extract extension from original image name
    const extension = imageName.split('.').pop()?.toLowerCase() || 'png';

    // Sanitize the base name to remove spaces and special characters
    const sanitizedBaseName = this.sanitizeFilename(baseName);

    // Generate a hash from the image content if available (for deduplication)
    let contentHash = '';
    if (imageData) {
      try {
        // Use a simple hash function based on the first 1000 chars of the image data
        // This helps identify duplicate images
        const sampleData = imageData.substring(0, 1000);
        contentHash = this.simpleHash(sampleData);
      } catch (e) {
        // Create a hash from the image name and base name as a fallback
        contentHash = this.simpleHash(`${baseName}-${imageName}`);
      }
    } else {
      // Create a hash from the image name and base name as a fallback
      contentHash = this.simpleHash(`${baseName}-${imageName}`);
    }

    // Create a deterministic name based on sanitized original name
    const sanitizedImageName = this.sanitizeFilename(imageName.split('.')[0]);

    // Combine elements for a unique but deterministic filename
    return `${sanitizedBaseName}-${sanitizedImageName}-${contentHash}.${extension}`;
  }

  /**
   * Creates a simple hash from a string
   * @param str String to hash
   * @returns A simple hash string
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    // Convert to a positive hex string and take the first 8 characters
    return (hash >>> 0).toString(16).substring(0, 8);
  }

  /**
   * Converts a base64 string to an ArrayBuffer
   * @param base64 The base64 string to convert
   * @returns ArrayBuffer
   */
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    // Remove data URL prefix if present
    const base64Data = base64.replace(/^data:image\/(png|jpeg|jpg|gif);base64,/, "");

    // Convert base64 to binary string
    const binaryString = window.atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);

    // Convert binary string to ArrayBuffer
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return bytes.buffer;
  }

  /**
   * Records metadata about processed images for tracking and debugging
   * @param metadata Image metadata to record
   */
  private recordImageMetadata(metadata: ImageMetadata): void {
    try {
      // Store in memory for the current session
      this.imageMetadataLog.push(metadata);

      // Log the metadata for debugging
    } catch (e) {
    }
  }

  /**
   * Sanitizes a filename to remove invalid characters
   * @param filename The filename to sanitize
   * @returns Sanitized filename
   */
  private sanitizeFilename(filename: string): string {
    // Replace spaces with hyphens and remove other special characters
    return filename.replace(/[^a-zA-Z0-9-_]/g, "-");
  }

  /**
   * Normalizes a path to ensure it's valid for Obsidian
   * @param path The path to normalize
   * @returns Normalized path
   */
  private normalizePath(path: string): string {
    // Normalize path separators and remove any leading/trailing slashes
    return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }
}
