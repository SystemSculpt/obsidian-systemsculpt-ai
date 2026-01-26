import { App, TFile, requestUrl } from "obsidian";
import { validateFileSize, formatFileSize } from "../utils/FileValidator";
import { logMobileError } from "../utils/errorHandling";
import { AUDIO_UPLOAD_MAX_BYTES } from "../constants/uploadLimits";

/**
 * Service responsible for audio upload and transcription
 */
export class AudioUploadService {
  private app: App;
  private baseUrl: string;

  constructor(app: App, baseUrl: string) {
    this.app = app;
    this.baseUrl = baseUrl;
  }

  /**
   * Update the base URL
   */
  public updateBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  /**
   * Upload an audio file to the server for speech-to-text extraction
   * Returns {documentId, status: "queued"|"processing"|"completed", cached?: boolean} if successful
   */
  public async uploadAudio(
    file: TFile
  ): Promise<{ documentId: string; status: string; cached?: boolean }> {
    try {
      const maxBytes = AUDIO_UPLOAD_MAX_BYTES;
      const maxSizeLabel = formatFileSize(maxBytes);
      // Validate file size first
      const isValidSize = await validateFileSize(file, this.app, {
        maxBytes,
        maxLabel: maxSizeLabel,
      });
      if (!isValidSize) {
        throw new Error(this.buildFileTooLargeMessage(file, maxBytes));
      }

      // Read file from vault
      const data = await this.app.vault.readBinary(file);
      const blob = new Blob([data], { type: "application/octet-stream" });

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
      parts.push(encoder.encode(`Content-Type: application/octet-stream\r\n`));
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

      // Make request using requestUrl instead of fetch for mobile compatibility
      const response = await requestUrl({
        url: `${this.baseUrl}/audio/transcriptions`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: formDataArray.buffer,
        throw: false,
      });

      const statusCode = this.normalizeStatusCode(response.status);
      if (statusCode !== 200) {
        const errorText = this.extractErrorText(response.text);
        const isPayloadTooLarge =
          statusCode === 413 ||
          /payload too large|function_payload_too_large/i.test(errorText);
        if (isPayloadTooLarge) {
          throw new Error(this.buildFileTooLargeMessage(file, maxBytes));
        }
        throw new Error(`Audio upload failed: ${statusCode || response.status}`);
      }
      const result = JSON.parse(response.text);
      return result;
    } catch (error) {
      // Log mobile error for audio upload failures
      logMobileError("AudioUploadService", "Audio upload failed", error, {
        filename: file.name,
        fileSize: file.stat.size,
        endpoint: `${this.baseUrl}/audio/transcriptions`
      });
      throw error;
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

  private buildFileTooLargeMessage(file: TFile, maxBytes: number): string {
    const fileSize = typeof file.stat?.size === "number" ? file.stat.size : 0;
    const sizeLabel = fileSize ? formatFileSize(fileSize) : "unknown size";
    const limitLabel = formatFileSize(maxBytes);
    return fileSize
      ? `File size (${sizeLabel}) exceeds the maximum upload limit (${limitLabel}). Please reduce the file size or split the audio.`
      : `File size exceeds the maximum upload limit (${limitLabel}). Please reduce the file size or split the audio.`;
  }
}
