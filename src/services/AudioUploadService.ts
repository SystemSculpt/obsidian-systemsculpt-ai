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
      const maxSizeLabel = formatFileSize(AUDIO_UPLOAD_MAX_BYTES);
      // Validate file size first
      const isValidSize = await validateFileSize(file, this.app, {
        maxBytes: AUDIO_UPLOAD_MAX_BYTES,
        maxLabel: maxSizeLabel,
      });
      if (!isValidSize) {
        throw new Error(`File size exceeds the maximum limit of ${maxSizeLabel}`);
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

      if (response.status !== 200) {
        if (response.status === 413) {
          throw new Error(`File size exceeds the maximum limit of ${maxSizeLabel}`);
        }
        throw new Error(`Audio upload failed: ${response.status}`);
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
}
