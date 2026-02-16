import { App, TFile, requestUrl } from "obsidian";
import { SystemSculptError, ERROR_CODES } from "../utils/errors";
import { validateFileSize, formatFileSize } from "../utils/FileValidator";
import { DOCUMENT_UPLOAD_MAX_BYTES } from "../constants/uploadLimits";
import {
  getDocumentMimeType,
  normalizeFileExtension,
} from "../constants/fileTypes";

/**
 * Service responsible for document upload and processing
 */
export class DocumentUploadService {
  private app: App;
  private baseUrl: string;
  private licenseKey: string;
  private pluginVersion: string;

  constructor(app: App, baseUrl: string, licenseKey: string, pluginVersion = "0.0.0") {
    this.app = app;
    this.baseUrl = baseUrl;
    this.licenseKey = licenseKey;
    this.pluginVersion = pluginVersion;
  }

  /**
   * Update the base URL and license key
   */
  public updateConfig(baseUrl: string, licenseKey: string, pluginVersion = this.pluginVersion): void {
    this.baseUrl = baseUrl;
    this.licenseKey = licenseKey;
    this.pluginVersion = pluginVersion;
  }

  /**
   * Upload a document to the server for processing
   * Returns {documentId, status: "queued" | "processing" | "completed", cached?: boolean} if successful
   */
  public async uploadDocument(
    file: TFile
  ): Promise<{ documentId: string; status: string; cached?: boolean }> {
    try {
      const maxBytes = DOCUMENT_UPLOAD_MAX_BYTES;
      const maxSizeLabel = formatFileSize(maxBytes);
      // Check if license is valid
      if (!this.licenseKey?.trim()) {
        throw new SystemSculptError(
          "A valid license key is required for document processing",
          ERROR_CODES.PRO_REQUIRED,
          403
        );
      }

      // Validate file size first
      const isValidSize = await validateFileSize(file, this.app, {
        maxBytes,
        maxLabel: maxSizeLabel,
      });
      if (!isValidSize) {
        throw this.buildFileTooLargeError(file, maxBytes);
      }

      const normalizedExtension = normalizeFileExtension(file.extension);
      const resolvedContentType =
        getDocumentMimeType(normalizedExtension) ?? "application/octet-stream";

      // Read file from vault
      const data = await this.app.vault.readBinary(file);
      const blob = new Blob([data], { type: resolvedContentType });

      // Generate boundary for multipart form data (RFC 7578 compliant)
      const boundary = 'WebKitFormBoundary' + Math.random().toString(36).substring(2, 15);
      
      // Build multipart form data manually with proper RFC 7578 formatting
      const encoder = new TextEncoder();
      const parts: Uint8Array[] = [];

      // Add file field
      parts.push(encoder.encode(`--${boundary}\r\n`));
      parts.push(encoder.encode(
        `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
      ));
      parts.push(
        encoder.encode(`Content-Type: ${resolvedContentType}\r\n`)
      );
      parts.push(encoder.encode('\r\n')); // Empty line between headers and content
      parts.push(new Uint8Array(await blob.arrayBuffer()));
      parts.push(encoder.encode('\r\n')); // CRLF after file content
      
      // Add final boundary with proper termination
      parts.push(encoder.encode(`--${boundary}--\r\n`));

      // Calculate total size and create final array
      const totalSize = parts.reduce((sum, part) => sum + part.length, 0);
      const formDataArray = new Uint8Array(totalSize);
      let offset = 0;
      
      for (const part of parts) {
        formDataArray.set(part, offset);
        offset += part.length;
      }

      // Construct the URL properly
      const url = `${this.baseUrl}/documents/process`;
      const idempotencyKey = `doc-upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      // Make request using requestUrl instead of fetch for mobile compatibility
      const response = await requestUrl({
        url: url,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'x-license-key': this.licenseKey,
          'x-plugin-version': this.pluginVersion,
          'Idempotency-Key': idempotencyKey,
        },
        body: formDataArray.buffer,
        throw: false,
      });

      const statusCode = this.normalizeStatusCode(response.status);
      if (statusCode !== 200) {
        // Try to get more detailed error information
        const errorText = this.extractErrorText(response.text);
        const isPayloadTooLarge =
          statusCode === 413 ||
          /payload too large|function_payload_too_large/i.test(errorText);

        // Handle specific error cases
        if (statusCode === 403) {
          throw new SystemSculptError(
            "Invalid or expired license key",
            ERROR_CODES.INVALID_LICENSE,
            403
          );
        }
        if (isPayloadTooLarge) {
          throw this.buildFileTooLargeError(file, maxBytes, errorText);
        }
        throw new SystemSculptError(
          `Upload failed: ${statusCode || response.status} ${errorText ? `- ${errorText}` : ''}`,
          ERROR_CODES.PROCESSING_ERROR,
          statusCode || 500
        );
      }

      // Parse the response
      try {
        const responseData = JSON.parse(response.text);
        return responseData;
      } catch (jsonError) {
        throw new SystemSculptError(
          "Invalid response format from server",
          ERROR_CODES.INVALID_RESPONSE,
          500
        );
      }
    } catch (error) {
      // Ensure we're always throwing a SystemSculptError
      if (error instanceof SystemSculptError) {
        throw error;
      }
      throw new SystemSculptError(
        error instanceof Error ? error.message : String(error),
        ERROR_CODES.PROCESSING_ERROR,
        500
      );
    }
  }

  private normalizeStatusCode(status: unknown): number {
    if (typeof status === "number" && Number.isFinite(status)) {
      return status;
    }
    if (typeof status === "string") {
      const parsed = Number.parseInt(status, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return 0;
  }

  private extractErrorText(rawText?: string): string {
    if (!rawText) {
      return "";
    }
    try {
      const parsed = JSON.parse(rawText);
      return (
        parsed?.error?.message ??
        parsed?.error ??
        parsed?.message ??
        rawText
      );
    } catch {
      return rawText;
    }
  }

  private buildFileTooLargeError(
    file: TFile,
    maxBytes: number,
    details?: string
  ): SystemSculptError {
    const fileSize = typeof file.stat?.size === "number" ? file.stat.size : 0;
    const sizeLabel = fileSize ? formatFileSize(fileSize) : "unknown size";
    const limitLabel = formatFileSize(maxBytes);
    const message = fileSize
      ? `File size (${sizeLabel}) exceeds the maximum upload limit (${limitLabel}). Please reduce the file size or split the document.`
      : `File size exceeds the maximum upload limit (${limitLabel}). Please reduce the file size or split the document.`;

    return new SystemSculptError(message, ERROR_CODES.FILE_TOO_LARGE, 413, {
      fileSize,
      maxBytes,
      details,
    });
  }
}
