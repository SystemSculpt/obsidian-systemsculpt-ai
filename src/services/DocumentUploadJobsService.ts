import { App, TFile, normalizePath, requestUrl } from "obsidian";
import { SystemSculptError, ERROR_CODES } from "../utils/errors";
import { getDocumentMimeType, normalizeFileExtension } from "../constants/fileTypes";

export type DocumentJobsUploadProgressEvent =
  | { stage: "creating"; progress: number; label: string }
  | { stage: "uploading"; progress: number; label: string; partNumber: number; totalParts: number }
  | { stage: "finalizing"; progress: number; label: string }
  | { stage: "starting"; progress: number; label: string };

export interface DocumentJobsUploadOptions {
  onProgress?: (event: DocumentJobsUploadProgressEvent) => void;
}

type JsonResult = { status: number; json: any; text: string; headers: Record<string, string> };

/**
 * Desktop-only multipart upload pipeline for document processing jobs.
 *
 * This matches the SystemSculpt audio jobs pattern: create a job, upload parts to presigned URLs,
 * complete the multipart upload, then start processing.
 */
export class DocumentUploadJobsService {
  private app: App;
  private baseUrl: string;
  private licenseKey: string;

  constructor(app: App, baseUrl: string, licenseKey: string) {
    this.app = app;
    this.baseUrl = baseUrl;
    this.licenseKey = licenseKey;
  }

  public updateConfig(baseUrl: string, licenseKey: string): void {
    this.baseUrl = baseUrl;
    this.licenseKey = licenseKey;
  }

  public async uploadDocumentViaJobs(
    file: TFile,
    options: DocumentJobsUploadOptions = {}
  ): Promise<{ documentId: string; status: string }> {
    const licenseKey = this.licenseKey?.trim();
    if (!licenseKey) {
      throw new SystemSculptError(
        "A valid license key is required for document processing",
        ERROR_CODES.PRO_REQUIRED,
        403
      );
    }

    const fileSize = typeof file.stat?.size === "number" ? file.stat.size : 0;
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      throw new SystemSculptError(
        "File size is unknown. Please retry after Obsidian finishes indexing the file.",
        ERROR_CODES.PROCESSING_ERROR,
        400
      );
    }

    const normalizedExtension = normalizeFileExtension(file.extension);
    const resolvedContentType =
      getDocumentMimeType(normalizedExtension) ?? "application/octet-stream";

    options.onProgress?.({
      stage: "creating",
      progress: 0,
      label: "Preparing multipart upload…",
    });

    const create = await this.requestSystemSculptJson({
      url: `${this.baseUrl}/documents/jobs`,
      method: "POST",
      body: {
        filename: file.name,
        contentType: resolvedContentType,
        contentLengthBytes: fileSize,
      },
    });

    if (create.status !== 200 || create.json?.success !== true) {
      throw this.toSystemSculptError(create, "Failed to create document upload job");
    }

    const documentId =
      typeof create.json?.documentId === "string"
        ? create.json.documentId
        : typeof create.json?.document_id === "string"
        ? create.json.document_id
        : "";

    const upload = create.json?.upload;
    const partSizeBytes = Number(upload?.partSizeBytes);
    const totalParts = Number(upload?.totalParts);

    if (!documentId) {
      throw new SystemSculptError(
        "Invalid response: missing documentId",
        ERROR_CODES.INVALID_RESPONSE,
        500
      );
    }
    if (!Number.isFinite(partSizeBytes) || partSizeBytes <= 0) {
      throw new SystemSculptError(
        "Invalid response: missing upload.partSizeBytes",
        ERROR_CODES.INVALID_RESPONSE,
        500
      );
    }
    if (!Number.isFinite(totalParts) || totalParts <= 0) {
      throw new SystemSculptError(
        "Invalid response: missing upload.totalParts",
        ERROR_CODES.INVALID_RESPONSE,
        500
      );
    }

    const absolutePath = this.resolveAbsolutePath(file);
    const fs = require("fs");
    const fileHandle = await fs.promises.open(absolutePath, "r");

    const parts: Array<{ partNumber: number; etag: string }> = [];

    try {
      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        const offset = (partNumber - 1) * partSizeBytes;
        const remaining = Math.max(0, fileSize - offset);
        const bytesToRead = Math.min(partSizeBytes, remaining);
        if (bytesToRead <= 0) {
          throw new SystemSculptError(
            `Unexpected end of file while uploading part ${partNumber}/${totalParts}.`,
            ERROR_CODES.PROCESSING_ERROR,
            500
          );
        }

        const sign = await this.requestSystemSculptJson({
          url: `${this.baseUrl}/documents/jobs/${documentId}/upload/part-url?partNumber=${partNumber}`,
          method: "GET",
        });

        if (sign.status !== 200 || sign.json?.success !== true) {
          throw this.toSystemSculptError(sign, `Failed to sign part ${partNumber}/${totalParts}`);
        }

        const signedUrl = sign.json?.part?.url;
        if (typeof signedUrl !== "string" || !signedUrl) {
          throw new SystemSculptError(
            "Invalid response: missing signed part URL",
            ERROR_CODES.INVALID_RESPONSE,
            500
          );
        }

        const chunk = new Uint8Array(bytesToRead);
        const read = await fileHandle.read(chunk, 0, bytesToRead, offset);
        if (read.bytesRead !== bytesToRead) {
          throw new SystemSculptError(
            `Short read while uploading part ${partNumber}/${totalParts} (expected ${bytesToRead}, got ${read.bytesRead}).`,
            ERROR_CODES.PROCESSING_ERROR,
            500
          );
        }

        options.onProgress?.({
          stage: "uploading",
          progress: Math.floor((partNumber / totalParts) * 90),
          label: `Uploading document (${partNumber}/${totalParts})…`,
          partNumber,
          totalParts,
        });

        const put = await requestUrl({
          url: signedUrl,
          method: "PUT",
          body: chunk.buffer,
          throw: false,
        });

        if (!put.status || put.status < 200 || put.status >= 300) {
          throw new SystemSculptError(
            `Part upload failed (HTTP ${put.status}) for part ${partNumber}/${totalParts}.`,
            ERROR_CODES.PROCESSING_ERROR,
            500
          );
        }

        const etagHeaderKey = Object.keys(put.headers ?? {}).find(
          (k) => k.toLowerCase() === "etag"
        );
        const etag = etagHeaderKey
          ? String((put.headers as any)[etagHeaderKey] ?? "").trim()
          : "";
        if (!etag) {
          throw new SystemSculptError(
            `Missing ETag for uploaded part ${partNumber}/${totalParts}.`,
            ERROR_CODES.PROCESSING_ERROR,
            500
          );
        }

        parts.push({ partNumber, etag });
      }
    } finally {
      await fileHandle.close().catch(() => {});
    }

    options.onProgress?.({
      stage: "finalizing",
      progress: 95,
      label: "Finalizing upload…",
    });

    const complete = await this.requestSystemSculptJson({
      url: `${this.baseUrl}/documents/jobs/${documentId}/upload/complete`,
      method: "POST",
      body: { parts },
    });

    if (complete.status !== 200 || complete.json?.success !== true) {
      throw this.toSystemSculptError(complete, "Failed to complete multipart upload");
    }

    options.onProgress?.({
      stage: "starting",
      progress: 100,
      label: "Starting document processing…",
    });

    // Start is best-effort; even if it fails, the user can retry and/or poll.
    await this.requestSystemSculptJson({
      url: `${this.baseUrl}/documents/jobs/${documentId}/start`,
      method: "POST",
      body: {},
    }).catch(() => {});

    return { documentId, status: "processing" };
  }

  private resolveAbsolutePath(file: TFile): string {
    const path = require("path");
    const adapter: any = this.app?.vault?.adapter;
    const normalized = normalizePath(file.path);

    if (adapter && typeof adapter.getFullPath === "function") {
      return adapter.getFullPath(normalized);
    }

    if (adapter && typeof adapter.basePath === "string" && adapter.basePath.trim()) {
      return path.join(adapter.basePath, normalized);
    }

    throw new SystemSculptError(
      "Unable to resolve an absolute file path for document upload. This upload mode requires desktop Obsidian.",
      ERROR_CODES.PROCESSING_ERROR,
      500
    );
  }

  private async requestSystemSculptJson(options: {
    url: string;
    method: "GET" | "POST";
    body?: any;
    headers?: Record<string, string>;
  }): Promise<JsonResult> {
    const licenseKey = this.licenseKey?.trim();
    const headers: Record<string, string> = {
      ...(licenseKey ? { "x-license-key": licenseKey } : {}),
      ...(options.method !== "GET" ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    };

    const response = await requestUrl({
      url: options.url,
      method: options.method,
      headers,
      ...(options.method !== "GET" ? { body: JSON.stringify(options.body ?? {}) } : {}),
      throw: false,
    });

    const json =
      response.json ??
      (() => {
        try {
          return response.text ? JSON.parse(response.text) : null;
        } catch {
          return null;
        }
      })();

    return {
      status: response.status,
      json,
      text: response.text ?? "",
      headers: response.headers ?? {},
    };
  }

  private toSystemSculptError(result: JsonResult, fallbackMessage: string): SystemSculptError {
    const messageFromBody =
      result.json?.error?.message ??
      result.json?.error ??
      result.json?.message ??
      (typeof result.text === "string" && result.text.trim() ? result.text.trim() : "");

    const message = messageFromBody ? String(messageFromBody) : fallbackMessage;
    const statusCode = typeof result.status === "number" && Number.isFinite(result.status) ? result.status : 500;

    const isPayloadTooLarge =
      statusCode === 413 ||
      /payload too large|function_payload_too_large|file too large/i.test(message);

    if (isPayloadTooLarge) {
      return new SystemSculptError(message, ERROR_CODES.FILE_TOO_LARGE, 413);
    }

    if (statusCode === 403) {
      return new SystemSculptError("Invalid or expired license key", ERROR_CODES.INVALID_LICENSE, 403);
    }

    return new SystemSculptError(message, ERROR_CODES.PROCESSING_ERROR, statusCode || 500);
  }
}

