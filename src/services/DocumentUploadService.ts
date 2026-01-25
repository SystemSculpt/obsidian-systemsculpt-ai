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

  constructor(app: App, baseUrl: string, licenseKey: string) {
    this.app = app;
    this.baseUrl = baseUrl;
    this.licenseKey = licenseKey;
  }

  /**
   * Update the base URL and license key
   */
  public updateConfig(baseUrl: string, licenseKey: string): void {
    this.baseUrl = baseUrl;
    this.licenseKey = licenseKey;
  }

  /**
   * Upload a document to the server for processing
   * Returns {documentId, status: "queued" | "processing" | "completed", cached?: boolean} if successful
   */
  public async uploadDocument(
    file: TFile
  ): Promise<{ documentId: string; status: string; cached?: boolean }> {
    try {
      const maxSizeLabel = formatFileSize(DOCUMENT_UPLOAD_MAX_BYTES);
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
        maxBytes: DOCUMENT_UPLOAD_MAX_BYTES,
        maxLabel: maxSizeLabel,
      });
      if (!isValidSize) {
        throw new SystemSculptError(
          `File size exceeds the maximum limit of ${maxSizeLabel}`,
          ERROR_CODES.FILE_TOO_LARGE,
          413
        );
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

      // Make request using requestUrl instead of fetch for mobile compatibility
      const response = await requestUrl({
        url: url,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'x-license-key': this.licenseKey,
        },
        body: formDataArray.buffer,
        throw: false,
      });

      if (response.status !== 200) {
        // Try to get more detailed error information
        let errorText = "";
        try {
          errorText = response.text;
        } catch (textError) {
          // Handle error silently
        }

        // Handle specific error cases
        if (response.status === 403) {
          throw new SystemSculptError(
            "Invalid or expired license key",
            ERROR_CODES.INVALID_LICENSE,
            403
          );
        }
        if (response.status === 413) {
          throw new SystemSculptError(
            `File size exceeds the maximum limit of ${maxSizeLabel}`,
            ERROR_CODES.FILE_TOO_LARGE,
            413
          );
        }
        throw new SystemSculptError(
          `Upload failed: ${response.status} ${errorText ? `- ${errorText}` : ''}`,
          ERROR_CODES.PROCESSING_ERROR,
          response.status
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
}
