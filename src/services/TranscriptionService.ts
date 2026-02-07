import { Plugin, Notice, Menu, TFile, MarkdownView, requestUrl, App, normalizePath } from "obsidian";
import { PlatformContext } from "./PlatformContext";
import { SystemSculptService } from "./SystemSculptService";
import type { SystemSculptSettings } from "../types";
import { SYSTEMSCULPT_API_HEADERS } from "../constants/api";
import { AUDIO_UPLOAD_MAX_BYTES } from "../constants/uploadLimits";
import type SystemSculptPlugin from "../main";
import { logDebug, logInfo, logWarning, logError, logMobileError } from "../utils/errorHandling";
import { AudioResampler } from "./AudioResampler";
import { SerialTaskQueue } from "../utils/SerialTaskQueue";

// Match server-side configuration
const SUPPORTED_AUDIO_EXTENSIONS = ["wav", "m4a", "webm", "ogg", "mp3"];
const CUSTOM_AUDIO_UPLOAD_MAX_BYTES = 25 * 1024 * 1024; // 25MB
const CHUNK_OVERLAP_SECONDS = 1;
const MIME_TYPE_MAP = {
  wav: "audio/wav",
  m4a: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
} as const;

// Maximum file size for upload (2GB)
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

// SystemSculpt server-side jobs pipeline limits (match systemsculpt-website).
const SYSTEMSCULPT_JOB_MAX_AUDIO_BYTES = 500 * 1024 * 1024;
const SYSTEMSCULPT_JOB_POLL_INTERVAL_MS = 2000;
const SYSTEMSCULPT_JOB_KICK_INTERVAL_MS = 60_000;
const SYSTEMSCULPT_JOB_TIMEOUT_MS = 30 * 60_000;

// Expected sample rates for different formats
const EXPECTED_SAMPLE_RATES: Record<string, number> = {
  wav: 16000,
  m4a: 16000,
  mp3: 16000,
  webm: 48000,
  ogg: 16000
};

export interface TranscriptionContext {
  type: "note" | "chat";
  timestamped?: boolean;
  onProgress?: (progress: number, status: string) => void;
  /** When true, avoid raising Obsidian Notices (for inline recorder UI). */
  suppressNotices?: boolean;
}

export class TranscriptionService {
  private static instance: TranscriptionService;
  private plugin: SystemSculptPlugin;
  private app: App;
  private sculptService: SystemSculptService;
  private platform: PlatformContext;
  private transcriptionQueue = new SerialTaskQueue();
  private retryCount: number = 0;
  private maxRetries: number = 2; // Maximum of 2 retries (3 attempts total)
  private retryDelay: number = 5000; // 5 seconds between retries
  private audioResampler: AudioResampler;
  private uploadQueue: Promise<string>[] = [];
  private activeUploads = 0;
  private maxConcurrentUploads = 1; // Process uploads one at a time to avoid rate limiting

  private constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    // Use singleton instance instead of creating new one
    this.sculptService = SystemSculptService.getInstance(plugin);
    this.platform = PlatformContext.get();
    this.audioResampler = new AudioResampler();
  }

  /**
   * Build a multipart/form-data request body from form fields.
   * Returns a Uint8Array suitable as a Request body along with the boundary string.
   */
  private async buildMultipartBody(
    formFields: Array<{ name: string; value: string | Blob; filename?: string }>,
    boundary: string
  ): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];

    for (const field of formFields) {
      parts.push(encoder.encode(`--${boundary}\r\n`));

      if (field.value instanceof Blob) {
        const rawContentType = field.value.type || "application/octet-stream";
        const contentType = rawContentType.split(";")[0] || rawContentType;
        const filename = field.filename || 'file';
        parts.push(
          encoder.encode(
            `Content-Disposition: form-data; name="${field.name}"; filename="${filename}"\r\n`
          )
        );
        parts.push(encoder.encode(`Content-Type: ${contentType}\r\n`));
        parts.push(encoder.encode('\r\n'));
        parts.push(new Uint8Array(await field.value.arrayBuffer()));
        parts.push(encoder.encode('\r\n'));
      } else {
        parts.push(
          encoder.encode(
            `Content-Disposition: form-data; name="${field.name}"\r\n`
          )
        );
        parts.push(encoder.encode('\r\n'));
        parts.push(encoder.encode(String(field.value)));
        parts.push(encoder.encode('\r\n'));
      }
    }

    parts.push(encoder.encode(`--${boundary}--\r\n`));
    const totalSize = parts.reduce((sum, p) => sum + p.length, 0);
    const body = new Uint8Array(totalSize);
    let offset = 0;
    for (const p of parts) {
      body.set(p, offset);
      offset += p.length;
    }
    return body;
  }

  /**
   * Parse an NDJSON text payload by scanning line-by-line and returning the last JSON object
   * that contains either { text } or { error } while surfacing progress callbacks.
   */
  private parseNdjsonText(
    rawText: string,
    onProgress?: (progress: number, status: string) => void
  ): any {
    const lines = rawText.trim().split('\n');
    let finalResponse: any = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && obj.progress_update && typeof onProgress === 'function') {
          const p = Number(obj.progress_update.progress);
          const s = String(obj.progress_update.status || '');
          if (!Number.isNaN(p)) onProgress(p, s);
        }
        if (obj && (obj.text || obj.error)) {
          finalResponse = obj;
        }
      } catch {}
    }
    return finalResponse ?? {};
  }

  /**
   * Stream and parse an NDJSON response from fetch, emitting progress as it arrives.
   * Returns the last JSON object with a text/error field.
   */
  private async parseNdjsonStream(
    response: Response,
    onProgress?: (progress: number, status: string) => void
  ): Promise<any> {
    if (!response.body) {
      // Fallback to text parsing when stream not available
      const text = await response.text();
      return this.parseNdjsonText(text, onProgress);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResponse: any = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj && obj.progress_update && typeof onProgress === 'function') {
            const p = Number(obj.progress_update.progress);
            const s = String(obj.progress_update.status || '');
            if (!Number.isNaN(p)) onProgress(p, s);
          }
          if (obj && (obj.text || obj.error)) {
            finalResponse = obj;
          }
        } catch {}
      }
    }
    // Flush any remaining buffer as a complete line
    const tail = buffer.trim();
    if (tail) {
      try {
        const obj = JSON.parse(tail);
        if (obj && (obj.text || obj.error)) finalResponse = obj;
      } catch {}
    }
    return finalResponse ?? {};
  }

  static getInstance(
    plugin: SystemSculptPlugin
  ): TranscriptionService {
    if (!TranscriptionService.instance) {
      TranscriptionService.instance = new TranscriptionService(plugin);
    }
    return TranscriptionService.instance;
  }

  private async parseErrorResponse(
    response: Response
  ): Promise<{ message: string; data?: any }> {
    try {
      const data = await response.json();
      if (data.error) {
        if (typeof data.error === "string") {
          return { message: data.error, data };
        }
        if (data.error.message) {
          return { message: data.error.message, data };
        }
        return { message: JSON.stringify(data.error), data };
      }
      return { message: response.statusText, data };
    } catch (e) {
      return { message: response.statusText };
    }
  }

  private resolveAudioUploadDescriptor(
    file: TFile,
    blob: Blob
  ): { filename: string; mimeType: string } {
    const rawType = (blob.type || "").toLowerCase();
    const normalizedType = rawType.split(";")[0] || rawType;
    const inferredExtension = normalizedType.includes("audio/wav")
      ? "wav"
      : normalizedType.includes("audio/webm")
      ? "webm"
      : normalizedType.includes("audio/mp4")
      ? "m4a"
      : normalizedType.includes("audio/mpeg")
      ? "mp3"
      : normalizedType.includes("audio/ogg")
      ? "ogg"
      : "";

    const fallbackExtension = (file.extension || "").toLowerCase();
    const extension = inferredExtension || fallbackExtension || "wav";
    const mimeType =
      (MIME_TYPE_MAP as Record<string, string>)[extension] ||
      normalizedType ||
      "application/octet-stream";

    const desiredSuffix = `.${extension}`;
    const candidateName = (file.name || "").trim();
    const baseName = (file.basename || "recording").trim() || "recording";
    const filename =
      candidateName && candidateName.toLowerCase().endsWith(desiredSuffix)
        ? candidateName
        : `${baseName}${desiredSuffix}`;

    return { filename, mimeType };
  }

  private extractRequestUrlErrorMessage(response: any): string {
    const rawText = typeof response?.text === "string" ? response.text : "";
    if (rawText) {
      try {
        const parsed = JSON.parse(rawText);
        return parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? rawText;
      } catch {
        return rawText;
      }
    }

    const status = typeof response?.status === "number" ? response.status : "unknown";
    return `HTTP ${status}`;
  }

  private async requestSystemSculptJson(options: {
    url: string;
    method: "GET" | "POST";
    body?: any;
    headers?: Record<string, string>;
  }): Promise<{ status: number; json: any; headers: Record<string, string>; text: string }> {
    const licenseKey = this.plugin.settings.licenseKey;
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
      headers: response.headers ?? {},
      text: response.text ?? "",
    };
  }

  private resolveAbsolutePath(file: TFile): string {
    const path = require("path");
    const adapter: any = this.plugin.app?.vault?.adapter;
    const normalized = normalizePath(file.path);

    if (adapter && typeof adapter.getFullPath === "function") {
      return adapter.getFullPath(normalized);
    }

    if (adapter && typeof adapter.basePath === "string" && adapter.basePath.trim()) {
      return path.join(adapter.basePath, normalized);
    }

    throw new Error(
      "Unable to resolve an absolute file path for transcription. This transcription mode requires desktop Obsidian."
    );
  }

  private segmentsToSrt(segments: any[]): string {
    return segments
      .map((segment: any, index: number) => {
        const start = this.formatTimestamp(Number(segment?.start ?? 0));
        const end = this.formatTimestamp(Number(segment?.end ?? 0));
        const text = String(segment?.text ?? "").trim();
        return `${index + 1}\n${start} --> ${end}\n${text}\n`;
      })
      .join("\n")
      .trim();
  }

  private async fetchSignedText(url: string): Promise<string> {
    const response = await requestUrl({ url, method: "GET", throw: false });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to fetch transcript (HTTP ${response.status}).`);
    }
    return String(response.text ?? "");
  }

  private async transcribeViaSystemSculptJobs(file: TFile, context?: TranscriptionContext): Promise<string> {
    const fileSize = typeof file.stat?.size === "number" ? file.stat.size : 0;
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      throw new Error("File size is unknown. Please retry after Obsidian finishes indexing the file.");
    }

    if (fileSize > SYSTEMSCULPT_JOB_MAX_AUDIO_BYTES) {
      throw new Error(
        `File too large for transcription. Maximum supported size is ${Math.floor(
          SYSTEMSCULPT_JOB_MAX_AUDIO_BYTES / (1024 * 1024)
        )}MB.`
      );
    }

    const extension = (file.extension || "").toLowerCase();
    const contentType =
      (MIME_TYPE_MAP as Record<string, string>)[extension] || "application/octet-stream";

    const absolutePath = this.resolveAbsolutePath(file);
    context?.onProgress?.(2, "Preparing upload...");

    const create = await this.requestSystemSculptJson({
      url: `${this.sculptService.baseUrl}/audio/transcriptions/jobs`,
      method: "POST",
      body: {
        filename: file.name,
        contentType,
        contentLengthBytes: fileSize,
        timestamped: !!context?.timestamped,
      },
    });

    if (create.status !== 200 || !create.json?.success || !create.json?.job?.id) {
      throw new Error(this.extractRequestUrlErrorMessage(create));
    }

    const jobId = String(create.json.job.id);
    const processingStrategyRaw =
      typeof create.json?.job?.processingStrategy === "string"
        ? create.json.job.processingStrategy
        : typeof create.json?.job?.processing_strategy === "string"
        ? create.json.job.processing_strategy
        : "";
    const processingStrategy = String(processingStrategyRaw || "").trim().toLowerCase();
    const isChunkedJob = processingStrategy === "chunked";
    const partSizeBytes = Number(create.json?.upload?.partSizeBytes);
    const totalParts = Number(create.json?.upload?.totalParts);

    if (!Number.isFinite(partSizeBytes) || partSizeBytes <= 0) {
      throw new Error("Server returned an invalid multipart partSizeBytes.");
    }
    if (!Number.isFinite(totalParts) || totalParts <= 0) {
      throw new Error("Server returned an invalid multipart totalParts.");
    }

    const fs = require("fs");
    const fileHandle = await fs.promises.open(absolutePath, "r");
    const parts: Array<{ partNumber: number; etag: string }> = [];

    try {
      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        const offset = (partNumber - 1) * partSizeBytes;
        const remaining = Math.max(0, fileSize - offset);
        const bytesToRead = Math.min(partSizeBytes, remaining);
        if (bytesToRead <= 0) {
          throw new Error(`Unexpected end of file while uploading part ${partNumber}/${totalParts}.`);
        }

        const sign = await this.requestSystemSculptJson({
          url: `${this.sculptService.baseUrl}/audio/transcriptions/jobs/${jobId}/upload/part-url?partNumber=${partNumber}`,
          method: "GET",
        });

        const signedUrl = sign.json?.part?.url;
        if (sign.status !== 200 || !sign.json?.success || typeof signedUrl !== "string" || !signedUrl) {
          throw new Error(this.extractRequestUrlErrorMessage(sign));
        }

        const chunk = new Uint8Array(bytesToRead);
        const { bytesRead } = await fileHandle.read(chunk, 0, bytesToRead, offset);
        if (bytesRead !== bytesToRead) {
          throw new Error(
            `Short read while uploading part ${partNumber}/${totalParts} (expected ${bytesToRead}, got ${bytesRead}).`
          );
        }

        context?.onProgress?.(
          5 + Math.floor((partNumber / totalParts) * 60),
          `Uploading audio (${partNumber}/${totalParts})...`
        );

        const put = await requestUrl({
          url: signedUrl,
          method: "PUT",
          body: chunk.buffer,
          throw: false,
        });

        if (put.status < 200 || put.status >= 300) {
          throw new Error(`Part upload failed (HTTP ${put.status}) for part ${partNumber}/${totalParts}.`);
        }

        const etagHeaderKey = Object.keys(put.headers ?? {}).find((k) => k.toLowerCase() === "etag");
        const etag = etagHeaderKey ? String((put.headers as any)[etagHeaderKey] ?? "").trim() : "";
        if (!etag) {
          throw new Error(`Missing ETag for uploaded part ${partNumber}/${totalParts}.`);
        }

        parts.push({ partNumber, etag });
      }
    } catch (error) {
      await this.requestSystemSculptJson({
        url: `${this.sculptService.baseUrl}/audio/transcriptions/jobs/${jobId}/upload/abort`,
        method: "POST",
      }).catch(() => {});
      throw error;
    } finally {
      await fileHandle.close().catch(() => {});
    }

    context?.onProgress?.(70, "Finalizing upload...");

    const complete = await this.requestSystemSculptJson({
      url: `${this.sculptService.baseUrl}/audio/transcriptions/jobs/${jobId}/upload/complete`,
      method: "POST",
      body: { parts },
    });
    if (complete.status !== 200 || !complete.json?.success) {
      throw new Error(this.extractRequestUrlErrorMessage(complete));
    }

    // For very large uploads, the server will chunk the audio before transcribing.
    // Surface that immediately so users understand why "transcription" may take longer.
    context?.onProgress?.(75, isChunkedJob ? "Chunking audio..." : "Transcribing audio...");

    const startUrl = `${this.sculptService.baseUrl}/audio/transcriptions/jobs/${jobId}/start`;
    const statusUrl = `${this.sculptService.baseUrl}/audio/transcriptions/jobs/${jobId}`;
    const deadline = Date.now() + SYSTEMSCULPT_JOB_TIMEOUT_MS;
    let lastKickAt = 0;

    const tryKick = async (): Promise<{ status: number; json: any }> => {
      lastKickAt = Date.now();
      const kicked = await this.requestSystemSculptJson({ url: startUrl, method: "POST" });
      if (kicked.status !== 200 && kicked.status !== 202) {
        throw new Error(this.extractRequestUrlErrorMessage(kicked));
      }
      return { status: kicked.status, json: kicked.json };
    };

    const extractResult = async (payload: any): Promise<string | null> => {
      if (!payload || typeof payload !== "object") return null;

      const text = typeof payload.text === "string" ? payload.text : "";
      const verbose = payload.verbose_json;

      if (context?.timestamped && verbose && Array.isArray(verbose.segments)) {
        return this.segmentsToSrt(verbose.segments);
      }

      if (text && (!context?.timestamped || this.hasTimestamps(text))) {
        return text.trim();
      }

      const transcriptUrls = payload.transcript_urls;
      const transcriptTextUrl = typeof transcriptUrls?.text === "string" ? transcriptUrls.text : null;
      const transcriptJsonUrl = typeof transcriptUrls?.json === "string" ? transcriptUrls.json : null;

      if (context?.timestamped && transcriptJsonUrl) {
        const jsonText = await this.fetchSignedText(transcriptJsonUrl);
        try {
          const json = JSON.parse(jsonText);
          if (Array.isArray(json?.segments)) {
            return this.segmentsToSrt(json.segments);
          }
        } catch {}
      }

      if (transcriptTextUrl) {
        const fetched = await this.fetchSignedText(transcriptTextUrl);
        if (fetched.trim()) return fetched.trim();
      }

      return null;
    };

    const kicked = await tryKick();
    if (kicked.status === 200) {
      const maybe = await extractResult(kicked.json);
      if (maybe) return maybe;
    }

    while (Date.now() < deadline) {
      const status = await this.requestSystemSculptJson({ url: statusUrl, method: "GET" });
      if (status.status !== 200 || !status.json?.success) {
        throw new Error(this.extractRequestUrlErrorMessage(status));
      }

      const jobStatus = String(status.json?.job?.status || "");
      if (jobStatus === "succeeded") {
        const transcript = status.json?.transcript;
        const textUrl = typeof transcript?.textUrl === "string" ? transcript.textUrl : null;
        const jsonUrl = typeof transcript?.jsonUrl === "string" ? transcript.jsonUrl : null;

        if (context?.timestamped && jsonUrl) {
          const jsonText = await this.fetchSignedText(jsonUrl);
          try {
            const json = JSON.parse(jsonText);
            if (Array.isArray(json?.segments)) return this.segmentsToSrt(json.segments);
          } catch {}
        }

        if (textUrl) {
          const fetched = await this.fetchSignedText(textUrl);
          if (fetched.trim()) return fetched.trim();
        }

        throw new Error("Transcription completed, but the transcript could not be retrieved. Please retry.");
      }

      if (jobStatus === "failed") {
        const msg = status.json?.job?.errorMessage;
        throw new Error(typeof msg === "string" && msg.trim() ? msg : "Transcription job failed.");
      }

      if (jobStatus === "expired") {
        throw new Error("Transcription job expired before it could complete. Please retry.");
      }

      const progress = status.json?.progress;
      const stage = typeof progress?.stage === "string" ? progress.stage.trim().toLowerCase() : "";
      const chunksTotal = typeof progress?.chunksTotal === "number" ? progress.chunksTotal : null;
      const chunksSucceeded = typeof progress?.chunksSucceeded === "number" ? progress.chunksSucceeded : null;
      const expectedChunks = typeof status.json?.job?.chunkCount === "number" ? status.json.job.chunkCount : null;

      if (stage === "chunking") {
        if (expectedChunks && expectedChunks > 0 && typeof chunksTotal === "number") {
          const created = Math.max(0, Math.min(expectedChunks, Math.floor(chunksTotal)));
          const pct = 75 + Math.floor((created / expectedChunks) * 4);
          context?.onProgress?.(pct, `Chunking audio (${created}/${expectedChunks})...`);
        } else {
          context?.onProgress?.(78, "Chunking audio...");
        }
      } else if (stage === "transcribing") {
        if (chunksTotal && chunksTotal > 0 && typeof chunksSucceeded === "number") {
          const done = Math.max(0, Math.min(chunksTotal, Math.floor(chunksSucceeded)));
          const pct = 80 + Math.floor((done / chunksTotal) * 18);
          context?.onProgress?.(pct, `Transcribing chunks (${done}/${chunksTotal})...`);
        } else {
          context?.onProgress?.(82, "Transcribing audio...");
        }
      } else if (stage === "assembling") {
        context?.onProgress?.(99, "Assembling transcript...");
      } else if (stage) {
        context?.onProgress?.(80, `Processing (${stage})...`);
      } else if (jobStatus) {
        context?.onProgress?.(80, `Processing (${jobStatus})...`);
      }

      if (Date.now() - lastKickAt >= SYSTEMSCULPT_JOB_KICK_INTERVAL_MS) {
        const kickedAgain = await tryKick();
        if (kickedAgain.status === 200) {
          const maybe = await extractResult(kickedAgain.json);
          if (maybe) return maybe;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, SYSTEMSCULPT_JOB_POLL_INTERVAL_MS));
    }

    throw new Error("Transcription timed out. Please try again in a few minutes.");
  }

  private async transcribeChunkedAudio(
    file: TFile,
    sourceArrayBuffer: ArrayBuffer,
    options: { maxChunkBytes: number; targetSampleRate: number },
    context?: TranscriptionContext
  ): Promise<string> {
    const { maxChunkBytes, targetSampleRate } = options;

    context?.onProgress?.(20, "Splitting audio into chunks…");

    const chunkBlobs = await this.buildWavChunkBlobs(
      sourceArrayBuffer,
      targetSampleRate,
      maxChunkBytes
    );

    if (chunkBlobs.length === 0) {
      throw new Error("Chunking produced zero audio chunks.");
    }

    this.info("Chunking audio for transcription", {
      filePath: file.path,
      chunks: chunkBlobs.length,
      maxChunkBytes,
      targetSampleRate,
    });

    const transcriptions: string[] = [];
    const reservedProgressStart = 20;
    const reservedProgressEnd = 98;
    const reservedProgressRange = Math.max(1, reservedProgressEnd - reservedProgressStart);

    for (let i = 0; i < chunkBlobs.length; i++) {
      const chunkNumber = i + 1;
      const chunkProgressStart = reservedProgressStart + Math.floor((i / chunkBlobs.length) * reservedProgressRange);
      const chunkProgressEnd = reservedProgressStart + Math.floor((chunkNumber / chunkBlobs.length) * reservedProgressRange);

      const chunkContext: TranscriptionContext | undefined = context
        ? {
            ...context,
            onProgress: (progress, status) => {
              const clamped = Math.max(0, Math.min(100, Number(progress) || 0));
              const mapped =
                chunkProgressStart +
                Math.round((clamped / 100) * Math.max(1, chunkProgressEnd - chunkProgressStart));
              context.onProgress?.(mapped, `Chunk ${chunkNumber}/${chunkBlobs.length}: ${status}`);
            },
            suppressNotices: true,
          }
        : undefined;

      const text = await this.queueTranscription(file, chunkBlobs[i], chunkContext, true);
      transcriptions.push(text);
    }

    return this.mergeTranscriptions(transcriptions);
  }

  private async buildWavChunkBlobs(
    sourceArrayBuffer: ArrayBuffer,
    targetSampleRate: number,
    maxChunkBytes: number
  ): Promise<Blob[]> {
    const audioContext = new AudioContext();
    try {
      let decoded: AudioBuffer;
      try {
        decoded = await audioContext.decodeAudioData(sourceArrayBuffer.slice(0));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to decode audio for chunking (${message}). This can happen if your platform can't decode the file format. Try converting the audio to MP3 or WAV and retry.`
        );
      }
      let audioBuffer: AudioBuffer = decoded;

      if (audioBuffer.sampleRate !== targetSampleRate) {
        const offlineContext = new OfflineAudioContext(
          audioBuffer.numberOfChannels,
          Math.ceil(audioBuffer.duration * targetSampleRate),
          targetSampleRate
        );
        const source = offlineContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(offlineContext.destination);
        source.start(0);
        audioBuffer = await offlineContext.startRendering();
      }

      if (audioBuffer.numberOfChannels > 1) {
        const length = audioBuffer.length;
        const mono = new Float32Array(length);
        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
          const data = audioBuffer.getChannelData(channel);
          for (let i = 0; i < length; i++) {
            mono[i] += data[i] / audioBuffer.numberOfChannels;
          }
        }
        const monoBuffer = audioContext.createBuffer(1, length, audioBuffer.sampleRate);
        monoBuffer.copyToChannel(mono, 0);
        audioBuffer = monoBuffer;
      }

      const channels = audioBuffer.numberOfChannels;
      const bytesPerSample = 2;
      const wavHeaderBytes = 44;
      const rawMaxSamples = Math.floor((maxChunkBytes - wavHeaderBytes) / (channels * bytesPerSample));
      const overlapSamples = Math.min(
        Math.floor(CHUNK_OVERLAP_SECONDS * audioBuffer.sampleRate),
        Math.floor(rawMaxSamples / 10)
      );
      const payloadSamples = rawMaxSamples - overlapSamples;

      if (!Number.isFinite(payloadSamples) || payloadSamples <= 0) {
        throw new Error("Chunk size too small for WAV encoding.");
      }

      const chunks: Blob[] = [];
      for (let start = 0; start < audioBuffer.length; start += payloadSamples) {
        const end = Math.min(start + payloadSamples + overlapSamples, audioBuffer.length);
        const chunkLength = end - start;
        if (chunkLength <= 0) break;

        const chunkBuffer = audioContext.createBuffer(channels, chunkLength, audioBuffer.sampleRate);
        for (let channel = 0; channel < channels; channel++) {
          const data = audioBuffer.getChannelData(channel).subarray(start, end);
          chunkBuffer.copyToChannel(data, channel, 0);
        }

        const wav = this.audioBufferToWav(chunkBuffer);
        chunks.push(new Blob([wav], { type: "audio/wav" }));
      }

      return chunks;
    } finally {
      try {
        if (audioContext.state !== "closed") {
          await audioContext.close();
        }
      } catch {}
    }
  }

  private audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
    const length = buffer.length * buffer.numberOfChannels * 2 + 44;
    const arrayBuffer = new ArrayBuffer(length);
    const view = new DataView(arrayBuffer);
    const channels: Float32Array[] = [];
    let offset = 0;
    let pos = 0;

    const setUint16 = (data: number) => {
      view.setUint16(pos, data, true);
      pos += 2;
    };

    const setUint32 = (data: number) => {
      view.setUint32(pos, data, true);
      pos += 4;
    };

    // RIFF identifier
    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8); // file length - 8
    setUint32(0x45564157); // "WAVE"

    // fmt sub-chunk
    setUint32(0x20746d66); // "fmt "
    setUint32(16); // subchunk1 size
    setUint16(1); // audio format (1 = PCM)
    setUint16(buffer.numberOfChannels);
    setUint32(buffer.sampleRate);
    setUint32(buffer.sampleRate * 2 * buffer.numberOfChannels); // byte rate
    setUint16(buffer.numberOfChannels * 2); // block align
    setUint16(16); // bits per sample

    // data sub-chunk
    setUint32(0x61746164); // "data"
    setUint32(length - pos - 4); // subchunk2 size

    const volume = 0.8;
    for (let i = 0; i < buffer.numberOfChannels; i++) {
      channels.push(buffer.getChannelData(i));
    }

    while (pos < length) {
      for (let i = 0; i < buffer.numberOfChannels; i++) {
        const sample = Math.max(-1, Math.min(1, channels[i][offset]));
        const val = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(pos, val * volume, true);
        pos += 2;
      }
      offset++;
    }

    return arrayBuffer;
  }

  /**
   * Transcribe an audio file
   * @param file The audio file to transcribe
   * @param blob The audio file blob
   * @param context Transcription context
   * @returns Promise resolving to the transcription text
   */
  private async transcribeAudio(
    file: TFile,
    blob: Blob,
    context?: TranscriptionContext
  ): Promise<string> {
    // Add a unique request ID to prevent duplicate processing
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

    // Determine endpoint and compose fields based on provider
    const isCustom = this.plugin.settings.transcriptionProvider === "custom";
    const endpoint = isCustom
      ? this.plugin.settings.customTranscriptionEndpoint
      : `${this.sculptService.baseUrl}/audio/transcriptions`;
    const isGroqCustom = isCustom && (endpoint || "").toLowerCase().includes("groq.com");
    const uploadDescriptor = this.resolveAudioUploadDescriptor(file, blob);

    let headers: Record<string, string> = {};
    const formFields: Array<{ name: string; value: string | Blob; filename?: string }> = [];

    if (!isCustom) {
      // Use SystemSculpt server proxy
      headers['Content-Type'] = `multipart/form-data; boundary=`; // placeholder, boundary appended below
      if (this.plugin.settings.licenseKey) headers['x-license-key'] = this.plugin.settings.licenseKey;

      // Server expects file + optional requestId and timestamped flag
      formFields.push({ name: 'file', value: blob, filename: uploadDescriptor.filename });
      formFields.push({ name: 'requestId', value: requestId });
      if (context?.timestamped) formFields.push({ name: 'timestamped', value: 'true' });
    } else {
      // Custom endpoint
      // Authorization header if provided
      if (this.plugin.settings.customTranscriptionApiKey) {
        headers['Authorization'] = `Bearer ${this.plugin.settings.customTranscriptionApiKey}`;
        if ((endpoint || "").toLowerCase().includes('groq.com')) {
          headers['X-Request-ID'] = `obsidian-client-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
          headers['Accept'] = 'application/json';
        }
      }
      headers['Content-Type'] = `multipart/form-data; boundary=`; // placeholder, boundary appended below

      if (isGroqCustom) {
        const fileBlob =
          blob.type && blob.type.toLowerCase() === uploadDescriptor.mimeType.toLowerCase()
            ? blob
            : new Blob([await blob.arrayBuffer()], { type: uploadDescriptor.mimeType });
        formFields.push({ name: 'file', value: fileBlob, filename: uploadDescriptor.filename });
        formFields.push({ name: 'model', value: this.plugin.settings.customTranscriptionModel || 'whisper-large-v3' });
        if (context?.timestamped) {
          formFields.push({ name: 'response_format', value: 'verbose_json' });
          formFields.push({ name: 'timestamp_granularities[]', value: 'segment' });
        } else {
          formFields.push({ name: 'response_format', value: 'text' });
        }
        formFields.push({ name: 'language', value: 'en' });
      } else {
        // OpenAI or other compatible custom endpoints
        formFields.push({ name: 'file', value: blob, filename: uploadDescriptor.filename });
        formFields.push({ name: 'model', value: this.plugin.settings.customTranscriptionModel || 'whisper-1' });
        formFields.push({ name: 'requestId', value: requestId });
        if (context?.timestamped) formFields.push({ name: 'timestamped', value: 'true' });
      }
    }

    // Build multipart body
    const boundary = 'WebKitFormBoundary' + Math.random().toString(36).substring(2, 15);
    const formDataArray = await this.buildMultipartBody(formFields, boundary);
    const requestBodyBuffer: ArrayBuffer = formDataArray.buffer as ArrayBuffer;
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;

    // Implement retry mechanism for 500 errors
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount <= this.maxRetries) {
      // Define formDataPreview and currentFormDataVersion at the start of the while loop scope
      // These are needed in the main catch block if an error occurs.
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const firstBytes = formDataArray.slice(0, 300);
      const lastBytes = formDataArray.slice(-200);
      const formDataPreview = {
        boundary: boundary,
        totalSize: formDataArray.length,
        formDataStart: decoder.decode(firstBytes),
        formDataEnd: decoder.decode(lastBytes),
        fieldCount: formFields.length,
        fields: formFields.map(f => ({ name: f.name, type: f.value instanceof Blob ? 'Blob' : 'string', filename: f.filename }))
      };
      const currentFormDataVersion = "v4.0-platform-context";

      try {
        const retryText = retryCount > 0 ? `Retry ${retryCount}/${this.maxRetries}: ` : "";
        context?.onProgress?.(10, `${retryText}Uploading audio...`);

        // Update progress (after endpoint/header determination)
        context?.onProgress?.(30, `${retryText}Transcribing audio...`);

        const transportOptions = { endpoint };
        const preferredTransport = this.platform.preferredTransport(transportOptions);
        const canStream = this.platform.supportsStreaming(transportOptions);

        const requestViaRequestUrl = async (): Promise<Response> => {
          const transportResponse = await requestUrl({
            url: endpoint,
            method: "POST",
            headers: { ...headers },
            body: requestBodyBuffer,
            throw: false,
          });

          let responseBody: string;
          const responseHeaders = new Headers();

          if (transportResponse.headers && transportResponse.headers["content-type"]) {
            responseHeaders.set("content-type", transportResponse.headers["content-type"]);
          }

          if (transportResponse.text) {
            responseBody = transportResponse.text;
          } else if (transportResponse.json) {
            responseBody = JSON.stringify(transportResponse.json);
            responseHeaders.set("content-type", "application/json");
          } else if (transportResponse.arrayBuffer) {
            const localDecoder = new TextDecoder();
            responseBody = localDecoder.decode(new Uint8Array(transportResponse.arrayBuffer));
          } else {
            responseBody = "";
          }

          const fallbackContentType = transportResponse.headers?.["content-type"] || "";
          if (fallbackContentType.includes("application/x-ndjson") || responseBody.includes("\n{")) {
            const finalResponse = this.parseNdjsonText(responseBody, context?.onProgress);
            responseBody = JSON.stringify(finalResponse || {});
            responseHeaders.set("content-type", "application/json");
          }

          return new Response(responseBody, {
            status: transportResponse.status || 500,
            statusText: transportResponse.status >= 200 && transportResponse.status < 300 ? "OK" : "Error",
            headers: responseHeaders,
          });
        };

        let response: Response;
        if (preferredTransport === "requestUrl") {
          response = await requestViaRequestUrl();
        } else {
          try {
            response = await fetch(endpoint, {
              method: "POST",
              headers,
              body: requestBodyBuffer,
            });
          } catch (fetchError) {
            // Multipart uploads can fail via direct fetch (e.g. CORS/preflight). requestUrl is more reliable.
            this.warn("Fetch upload failed; falling back to requestUrl", {
              endpoint,
              error: fetchError instanceof Error ? fetchError.message : String(fetchError),
            });
            response = await requestViaRequestUrl();
          }
        }

        
        // Get content type from headers
        const contentType = response.headers.get('content-type') || '';

        if (!response.ok) {
          let rawResponseText = '';
          try {
            rawResponseText = await response.text();
          } catch (e) {
          }
          
          let errorMessage = `HTTP ${response.status}`;
          let errorToLog: Error & { additionalInfo?: any };
          const additionalLogInfo: any = {
            formDataVersion: currentFormDataVersion, // Use updated version
            endpoint,
            status: response.status,
            statusText: response.statusText,
            headers: contentType ? { 'content-type': contentType } : {},
            retryCount: retryCount + 1,
            provider: this.plugin.settings.transcriptionProvider,
            formDataDebug: formDataPreview, // formDataPreview is defined above
            rawResponseText: rawResponseText ? rawResponseText.substring(0, 1000) + (rawResponseText.length > 1000 ? '...' : '') : "N/A",
          };

          try {
            const errorData = JSON.parse(rawResponseText || "{}");
            
            if (errorData?.error?.message) {
              errorMessage = errorData.error.message;
            } else if (errorData?.error) {
              errorMessage = typeof errorData.error === 'string' ? errorData.error : JSON.stringify(errorData.error);
            } else if (errorData?.message) {
              errorMessage = errorData.message;
            }
            errorToLog = new Error(errorMessage) as Error & { additionalInfo?: any };
            additionalLogInfo.parsedErrorData = errorData;

          } catch (jsonParseError) {
            const e = jsonParseError instanceof Error ? jsonParseError : new Error(String(jsonParseError));
            errorMessage = `Failed to parse server error response as JSON (HTTP ${response.status}). Parser error: ${e.message}`;
            errorToLog = new Error(errorMessage) as Error & { additionalInfo?: any };
            additionalLogInfo.jsonParsingError = e.message;
          }
        
          errorToLog.additionalInfo = additionalLogInfo;
          
          await logMobileError("TranscriptionService", `API Error (HTTP ${response.status}) on attempt ${retryCount + 1}`, errorToLog, additionalLogInfo);
          
          throw errorToLog;
        }

        // Status is 200, now try to parse (stream NDJSON on desktop)
        let rawResponseTextFor200: string = "";
        let responseData: any;

        try {
          if (contentType.includes('application/x-ndjson') && canStream) {
            responseData = await this.parseNdjsonStream(response, context?.onProgress);
          } else {
            rawResponseTextFor200 = await response.text();
            if (contentType.includes('application/x-ndjson')) {
              responseData = this.parseNdjsonText(rawResponseTextFor200, context?.onProgress);
            } else {
              responseData = JSON.parse(rawResponseTextFor200 || '{}');
            }
          }
        } catch (jsonParseError) {
          const e = jsonParseError instanceof Error ? jsonParseError : new Error(String(jsonParseError));
          let errorMessage = e.message; // Default to original error message
          
          // Check if this is the specific NDJSON parsing issue
          if (contentType.includes('application/x-ndjson') && e.message.includes('Unexpected non-whitespace character after JSON')) {
            errorMessage = `NDJSON parsing failed. The server returned streaming JSON but it couldn't be processed properly. This might be due to response format incompatibility.`;
          } else if (!contentType.includes('application/x-ndjson') && e.name === 'SyntaxError') {
             // Only override if it was a SyntaxError AND we weren't expecting NDJSON
             errorMessage = `HTTP 200 but failed to parse response as JSON. Parser error: ${e.message}`;
          }
          const errorToLog = new Error(errorMessage) as Error & { additionalInfo?: any };
          
          const additionalLogInfo: any = {
            formDataVersion: currentFormDataVersion,
            endpoint,
            status: response.status,
            headers: response.headers,
            retryCount: retryCount + 1,
            provider: this.plugin.settings.transcriptionProvider,
            formDataDebug: formDataPreview,
            rawResponseText: rawResponseTextFor200 ? rawResponseTextFor200.substring(0, 1000) + (rawResponseTextFor200.length > 1000 ? '...' : '') : "N/A",
            jsonParsingError: e.message,
            contentType: contentType,
            location: "transcribeAudio - HTTP 200 JSON parse failed"
          };
          errorToLog.additionalInfo = additionalLogInfo;
          
          // Log this specific failure point before throwing
          await logMobileError(
            "TranscriptionService.transcribeAudio", 
            `HTTP 200 with unparseable JSON on attempt ${retryCount + 1}. Error: ${e.message}`,
            errorToLog, 
            additionalLogInfo
          );
          
          throw errorToLog; // This error will be caught by the outer try-catch and potentially retried or rethrown
        }

        // Update progress
        context?.onProgress?.(70, `${retryText}Processing response...`);

        // Parse response

        let transcriptionText = "";

        // Handle different response formats
        if (this.plugin.settings.transcriptionProvider === "custom" && 
            this.plugin.settings.customTranscriptionEndpoint.includes("groq.com")) {
          // Groq API response format
          if (context?.timestamped && responseData.segments) {
            // Convert segments to SRT format (simplified)
            transcriptionText = responseData.segments.map((segment: any, index: number) => {
              const start = this.formatTimestamp(segment.start);
              const end = this.formatTimestamp(segment.end);
              return `${index + 1}\n${start} --> ${end}\n${segment.text.trim()}\n`;
            }).join('\n');
            } else {
            transcriptionText = responseData.text || "";
          }
                } else {
          // SystemSculpt or other API response format
          if (typeof responseData === 'string') {
            transcriptionText = responseData;
          } else if (responseData.text) {
            transcriptionText = responseData.text;
          } else if (responseData.data?.text) {
            transcriptionText = responseData.data.text;
          } else {
            throw new Error("Invalid response format: no transcription text found");
          }
        }

        if (!transcriptionText?.trim()) {
          throw new Error("Empty transcription text received");
        }

        // Update progress
        context?.onProgress?.(100, "Transcription complete!");

        return transcriptionText.trim();

      } catch (error) {
        // Store the error for potential re-throw if this is the last attempt
        let currentError = error instanceof Error ? error : new Error(String(error));
        if ((error as any)?.additionalInfo && !(currentError as any).additionalInfo) {
          (currentError as any).additionalInfo = (error as any).additionalInfo;
        }
        lastError = currentError;

        const isFinalAttempt = retryCount >= this.maxRetries;
        
        if (isFinalAttempt) { 
          const finalLogAdditionalInfo = {
            finalAttempt: retryCount + 1,
            maxRetries: this.maxRetries,
            endpoint: this.plugin.settings.transcriptionProvider === "custom" ? 
              this.plugin.settings.customTranscriptionEndpoint : 
              `${this.sculptService.baseUrl}/audio/transcriptions`,
            fileSize: `${Math.round(blob.size / 1024)}KB`,
            provider: this.plugin.settings.transcriptionProvider,
            ...((lastError as any).additionalInfo || {}),
          };
          // Ensure formDataVersion is current if lastError didn't have it or had an old one
          finalLogAdditionalInfo.formDataVersion = (lastError as any).additionalInfo?.formDataVersion || currentFormDataVersion;

          await logMobileError("TranscriptionService", `All ${this.maxRetries + 1} attempts failed. Final error: ${lastError.message}`, lastError, finalLogAdditionalInfo);
        } else {
        }

        const messageForRetryCheck = lastError.message.toLowerCase();
        const is500Error = messageForRetryCheck.includes("500") ||
                           messageForRetryCheck.includes("internal_error") ||
                           messageForRetryCheck.includes("server error") ||
                           messageForRetryCheck.includes("failed to parse server error response as json");

        const isNetworkError = messageForRetryCheck.includes("failed to fetch") ||
                               messageForRetryCheck.includes("network error") ||
                               messageForRetryCheck.includes("connectivity") ||
                               messageForRetryCheck.includes("offline") ||
                               messageForRetryCheck.includes("request failed") ||
                               messageForRetryCheck.includes("connection was lost");

        const shouldRetry = (is500Error || isNetworkError) && retryCount < this.maxRetries;

        if (shouldRetry) {
          retryCount++;
          const backoffMs = 1000 * Math.pow(2, retryCount - 1);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        } else {
          throw lastError;
        }
      }
    }

    // This should never be reached, but just in case
    throw lastError || new Error("Unknown transcription error");
  }

  /**
   * Format timestamp for SRT format
   */
  private formatTimestamp(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
  }

  /**
   * Find the longest common suffix/prefix between two strings
   * @param str1 First string
   * @param str2 Second string
   * @param maxOverlapLength Maximum overlap length to consider
   * @returns The length of the overlap
   */
  private findOverlap(str1: string, str2: string, maxOverlapLength: number = 150): number {
    // Limit the search to a reasonable length
    const searchLength = Math.min(str1.length, str2.length, maxOverlapLength);

    // Normalize strings for better matching
    const normalizedStr1 = str1.toLowerCase().trim();
    const normalizedStr2 = str2.toLowerCase().trim();

    // First try exact matching for the best possible overlap
    for (let i = searchLength; i > 10; i--) { // Require at least 10 chars for exact match
      const suffix = normalizedStr1.slice(-i);
      const prefix = normalizedStr2.slice(0, i);

      if (suffix === prefix) {
        return i;
      }
    }

    // If exact matching fails, try fuzzy matching for partial overlaps
    // This helps with transcription errors at chunk boundaries
    for (let i = Math.min(100, searchLength); i > 20; i--) { // Use smaller window for fuzzy matching
      const suffix = normalizedStr1.slice(-i);
      const prefix = normalizedStr2.slice(0, i);

      // Calculate similarity (percentage of matching words)
      const suffixWords = suffix.split(/\s+/);
      const prefixWords = prefix.split(/\s+/);

      // Skip if too few words to compare
      if (suffixWords.length < 3 || prefixWords.length < 3) continue;

      // Count matching words
      let matchCount = 0;
      for (const word of suffixWords) {
        if (word.length > 2 && prefixWords.includes(word)) { // Only count words with 3+ chars
          matchCount++;
        }
      }

      // If more than 70% of words match, consider it an overlap
      const similarity = matchCount / suffixWords.length;
      if (similarity > 0.7) {
        // Find the position where the overlap starts in str2
        // by looking for the first matching word
        for (let j = 0; j < prefixWords.length; j++) {
          if (prefixWords[j].length > 2 && suffixWords.includes(prefixWords[j])) {
            // Calculate approximate position
            const approxPos = normalizedStr2.indexOf(prefixWords.slice(j).join(' '));
            if (approxPos >= 0) {
              return approxPos;
            }
          }
        }

        // Fallback to using the full prefix length
        return prefix.length;
      }
    }

    return 0;
  }

  /**
   * Check if text contains timestamps in SRT or VTT format
   * @param text The text to check
   * @returns True if the text contains timestamps
   */
  private hasTimestamps(text: string): boolean {
    // Check for SRT format timestamps (00:00:00,000 --> 00:00:00,000)
    const srtPattern = /\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/;

    // Check for VTT format timestamps (00:00:00.000 --> 00:00:00.000)
    const vttPattern = /\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/;

    return srtPattern.test(text) || vttPattern.test(text);
  }

  /**
   * Parse timestamps from text in SRT or VTT format
   * @param text The text containing timestamps
   * @returns Array of parsed timestamps with their positions
   */
  private parseTimestamps(text: string): Array<{
    index: number,
    startTime: string,
    endTime: string,
    startSeconds: number,
    endSeconds: number
  }> {
    const result: Array<{
      index: number,
      startTime: string,
      endTime: string,
      startSeconds: number,
      endSeconds: number
    }> = [];

    // Match both SRT and VTT format timestamps
    const timestampRegex = /(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[,\.]\d{3})/g;

    let match;
    while ((match = timestampRegex.exec(text)) !== null) {
      const startTime = match[1];
      const endTime = match[2];

      // Convert timestamp to seconds
      const startSeconds = this.timestampToSeconds(startTime);
      const endSeconds = this.timestampToSeconds(endTime);

      result.push({
        index: match.index,
        startTime,
        endTime,
        startSeconds,
        endSeconds
      });
    }

    return result;
  }

  /**
   * Convert a timestamp string to seconds
   * @param timestamp Timestamp in format 00:00:00,000 or 00:00:00.000
   * @returns Time in seconds
   */
  private timestampToSeconds(timestamp: string): number {
    // Replace comma with dot for consistent parsing
    const normalizedTimestamp = timestamp.replace(',', '.');

    // Split into hours, minutes, seconds
    const parts = normalizedTimestamp.split(':');
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);

    // Handle seconds and milliseconds
    const secondsParts = parts[2].split('.');
    const seconds = parseInt(secondsParts[0], 10);
    const milliseconds = secondsParts.length > 1 ? parseInt(secondsParts[1], 10) : 0;

    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
  }

  /**
   * Convert seconds to a timestamp string
   * @param seconds Time in seconds
   * @param format Format to use ('srt' or 'vtt')
   * @returns Formatted timestamp string
   */
  private secondsToTimestamp(seconds: number, format: 'srt' | 'vtt' = 'srt'): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const milliseconds = Math.floor((seconds % 1) * 1000);

    // Format with leading zeros
    const hoursStr = hours.toString().padStart(2, '0');
    const minutesStr = minutes.toString().padStart(2, '0');
    const secsStr = secs.toString().padStart(2, '0');
    const millisecondsStr = milliseconds.toString().padStart(3, '0');

    // Use comma for SRT, dot for VTT
    const separator = format === 'srt' ? ',' : '.';

    return `${hoursStr}:${minutesStr}:${secsStr}${separator}${millisecondsStr}`;
  }

  /**
   * Adjust timestamps in a text by adding an offset
   * @param text Text containing timestamps
   * @param offsetSeconds Offset to add to timestamps in seconds
   * @returns Text with adjusted timestamps
   */
  private adjustTimestamps(text: string, offsetSeconds: number): string {
    if (offsetSeconds === 0) {
      return text;
    }

    // Parse timestamps
    const timestamps = this.parseTimestamps(text);

    // If no timestamps found, return original text
    if (timestamps.length === 0) {
      return text;
    }

    // Determine format (SRT or VTT)
    const format = text.includes(',') ? 'srt' : 'vtt';
    const separator = format === 'srt' ? ',' : '.';

    // Sort timestamps by index in reverse order to avoid changing positions
    timestamps.sort((a, b) => b.index - a.index);

    // Create a copy of the text to modify
    let result = text;

    // Replace each timestamp with adjusted version
    for (const timestamp of timestamps) {
      const newStartSeconds = Math.max(0, timestamp.startSeconds + offsetSeconds);
      const newEndSeconds = Math.max(0, timestamp.endSeconds + offsetSeconds);

      const newStartTime = this.secondsToTimestamp(newStartSeconds, format);
      const newEndTime = this.secondsToTimestamp(newEndSeconds, format);

      const originalTimestamp = `${timestamp.startTime} --> ${timestamp.endTime}`;
      const newTimestamp = `${newStartTime} --> ${newEndTime}`;

      // Replace the timestamp in the text
      result = result.substring(0, timestamp.index) +
               newTimestamp +
               result.substring(timestamp.index + originalTimestamp.length);
    }

    return result;
  }

  /**
   * Parse SRT formatted text into entries
   * @param text SRT formatted text
   * @returns Array of SRT entries with index, timestamp, and content
   */
  private parseSrtEntries(text: string): Array<{
    index: number,
    entryNumber: number,
    timestamp: string,
    content: string
  }> {
    const result: Array<{
      index: number,
      entryNumber: number,
      timestamp: string,
      content: string
    }> = [];

    // Split the text into entries (separated by double newlines)
    const entries = text.split(/\n\s*\n/).filter(entry => entry.trim().length > 0);

    for (const entry of entries) {
      const lines = entry.trim().split('\n');

      // Need at least 3 lines for a valid SRT entry (number, timestamp, content)
      if (lines.length < 3) continue;

      // First line should be the entry number
      const entryNumber = parseInt(lines[0], 10);
      if (isNaN(entryNumber)) continue;

      // Second line should be the timestamp
      const timestamp = lines[1];
      if (!timestamp.includes('-->')) continue;

      // Remaining lines are the content
      const content = lines.slice(2).join('\n');

      result.push({
        index: text.indexOf(entry),
        entryNumber,
        timestamp,
        content
      });
    }

    return result;
  }

  /**
   * Check if SRT entries are in reverse order (descending numbers)
   * @param entries Array of SRT entries
   * @returns True if entries are in reverse order
   */
  private isReversedSrtNumbering(entries: Array<{entryNumber: number}>): boolean {
    if (entries.length < 2) return false;

    // Check if the first entry has a higher number than the last entry
    const firstNumber = entries[0].entryNumber;
    const lastNumber = entries[entries.length - 1].entryNumber;

    // Also check if the numbers are consistently decreasing
    let isConsistentlyDecreasing = true;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].entryNumber >= entries[i-1].entryNumber) {
        isConsistentlyDecreasing = false;
        break;
      }
    }

    return firstNumber > lastNumber && isConsistentlyDecreasing;
  }

  /**
   * Check if SRT entries have unusual numbering (non-sequential, very high numbers, etc.)
   * @param entries Array of SRT entries
   * @returns True if entries have unusual numbering
   */
  private hasUnusualSrtNumbering(entries: Array<{entryNumber: number}>): boolean {
    if (entries.length < 2) return false;

    // Consider any numbering that doesn't start with 1 as unusual
    if (entries[0].entryNumber !== 1) return true;

    // Check if entries are in reverse order (descending)
    const isReversed = this.isReversedSrtNumbering(entries);
    if (isReversed) return true;

    // For normal ascending order, check for non-sequential numbering
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].entryNumber !== entries[i-1].entryNumber + 1) {
        return true;
      }
    }

    return false;
  }

  /**
   * Renumber SRT entries in text
   * @param text SRT formatted text
   * @param startNumber The number to start from
   * @returns Text with renumbered entries
   */
  private renumberSrtEntries(text: string, startNumber: number): string {
    const entries = this.parseSrtEntries(text);

    if (entries.length === 0) {
      return text;
    }

    // Check if entries are in reverse order (like 357, 356, 355...)
    const isReversed = this.isReversedSrtNumbering(entries);

    // If entries are reversed, sort them by position in the text
    // Otherwise, keep them in their original order for proper sequential numbering
    let sortedEntries = [...entries];

    // For both normal and reversed cases, we need to process entries in reverse order
    // to avoid changing positions when we modify the text
    sortedEntries.sort((a, b) => b.index - a.index);

    // Create a copy of the text to modify
    let result = text;

    // Replace each entry number with the new number
    for (let i = 0; i < sortedEntries.length; i++) {
      const entry = sortedEntries[i];

      // If entries were reversed, we need to assign numbers in reverse order
      // to maintain the same sequence but with correct numbering
      const newEntryNumber = isReversed
        ? startNumber + (sortedEntries.length - 1 - i)
        : startNumber + i;

      // Replace the entry number in the text
      const originalEntryNumber = entry.entryNumber.toString();
      const newEntryNumberStr = newEntryNumber.toString();

      // Find the exact position of the entry number at the beginning of the entry
      const entryStart = result.indexOf(entry.timestamp, entry.index) - originalEntryNumber.length - 1;
      if (entryStart >= 0) {
        result = result.substring(0, entryStart) +
                newEntryNumberStr +
                result.substring(entryStart + originalEntryNumber.length);
      }
    }

    return result;
  }

  /**
   * Check if text is in SRT format
   * @param text The text to check
   * @returns True if the text is in SRT format
   */
  private isSrtFormat(text: string): boolean {
    // Check for SRT format: numbered entries followed by timestamps
    const srtPattern = /^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/m;
    return srtPattern.test(text);
  }

  /**
   * Merge multiple chunk transcriptions into a single result with overlap detection
   * and timestamp adjustment for timestamped transcriptions
   * @param transcriptions Array of transcription texts
   * @returns Merged transcription text
   */
  private mergeTranscriptions(
    transcriptions: string[]
  ): string {
    if (transcriptions.length === 0) {
      return "";
    }

    if (transcriptions.length === 1) {
      // For single transcriptions, always check and fix SRT numbering
      const isSrt = this.isSrtFormat(transcriptions[0]);
      if (isSrt) {
        const entries = this.parseSrtEntries(transcriptions[0]);

        // Check for any numbering issues
        const isReversed = this.isReversedSrtNumbering(entries);
        const hasUnusual = this.hasUnusualSrtNumbering(entries);
        const firstNumber = entries.length > 0 ? entries[0].entryNumber : 0;

        // Log detailed information about the numbering

        // Always renumber entries to ensure they start from 1
        // This fixes both reversed and unusual numbering cases
        if (entries.length > 0 && (isReversed || hasUnusual || firstNumber !== 1)) {

          // Create a new SRT file with correct sequential numbering
          let result = "";

          // Always sort entries by their position in the text (index)
          // This ensures correct chronological order regardless of original numbering
          const sortedEntries = [...entries].sort((a, b) => a.index - b.index);

          for (let i = 0; i < sortedEntries.length; i++) {
            const entry = sortedEntries[i];
            const entryNumber = i + 1;

            // Add a separator between entries
            if (i > 0) {
              result += "\n\n";
            }

            // Add the entry with new sequential numbering
            result += `${entryNumber}\n${entry.timestamp}\n${entry.content}`;
          }

          return result;
        }
      }

      return transcriptions[0];
    }

    // Check if we're dealing with timestamped transcriptions
    const hasTimestamps = this.hasTimestamps(transcriptions[0]);
    const isSrt = this.isSrtFormat(transcriptions[0]);

    if (hasTimestamps && isSrt) {
      // For timestamped transcriptions with SRT format
      let result = "";

      // We'll collect all entries from all chunks and renumber them sequentially
      let allEntries: Array<{
        index: number,
        entryNumber: number,
        timestamp: string,
        content: string,
        chunkIndex: number
      }> = [];

      // First pass: collect all entries from all chunks
      for (let i = 0; i < transcriptions.length; i++) {
        const transcription = transcriptions[i];

        // Parse entries from this chunk
        const entries = this.parseSrtEntries(transcription);

        // Log if we detect reversed or unusual numbering
        if (this.isReversedSrtNumbering(entries)) {
        }

        // Check for unusual numbering (other than simple reversed numbering)
        if (this.hasUnusualSrtNumbering(entries)) {
        }

        // Add chunk index to each entry
        entries.forEach(entry => {
          allEntries.push({
            ...entry,
            chunkIndex: i
          });
        });
      }

      // Always renumber entries for consistency, regardless of whether unusual numbering was detected

      // Sort entries by chunk index first to maintain the correct order of chunks
      // Then by their position within each chunk to maintain chronological order
      allEntries.sort((a, b) => {
        // First sort by chunk index
        if (a.chunkIndex !== b.chunkIndex) {
          return a.chunkIndex - b.chunkIndex;
        }

        // Within the same chunk, sort by position in text
        // This ensures correct chronological order regardless of original numbering
        return a.index - b.index;
      });

      // Create a completely new SRT file with sequential numbering starting from 1
      for (let i = 0; i < allEntries.length; i++) {
        const entry = allEntries[i];
        const entryNumber = i + 1; // Always start from 1 and increment sequentially

        // Add a separator between entries
        if (i > 0) {
          result += "\n\n";
        }

        // Add the entry with new sequential numbering
        result += `${entryNumber}\n${entry.timestamp}\n${entry.content}`;
      }

      return result;
    } else if (hasTimestamps) {
      // For other timestamped formats (non-SRT)
      let result = "";

      // Process each chunk's transcription
      for (let i = 0; i < transcriptions.length; i++) {
        const transcription = transcriptions[i];

        // Add a separator between chunks
        if (i > 0) {
          result += "\n\n";
        }

        result += transcription;
      }

      return result;
    } else {
      // For regular transcriptions, use enhanced text-based merging with improved continuity
      let result = transcriptions[0];

      // Process each subsequent transcription
      for (let i = 1; i < transcriptions.length; i++) {
        const current = transcriptions[i];

        // Find overlap between the end of the result and the start of the current chunk
        // Use a larger search window for better overlap detection
        const overlapLength = this.findOverlap(result, current, 300);

        if (overlapLength > 0) {
          // Append only the non-overlapping part of the current chunk
          result += current.slice(overlapLength);
        } else {
          // If no overlap found, try to create a more natural transition

          // Check if the last character of result is already a punctuation or space
          const lastChar = result.charAt(result.length - 1);
          const endsWithPunctuation = /[.!?]/.test(lastChar);
          const endsWithSpace = /\s/.test(lastChar);

          // Check if the first character of current is uppercase (potential new sentence)
          const firstChar = current.charAt(0);
          const startsWithUppercase = /[A-Z]/.test(firstChar);

          if (endsWithPunctuation) {
            // If result ends with punctuation, add a space before the new chunk
            result += " ";
            result += current;
          } else if (endsWithSpace) {
            // If result already ends with space, just append
            result += current;
          } else {
            // No punctuation or space at the end
            // If the next chunk starts with uppercase, add period and space
            if (startsWithUppercase) {
              result += ". " + current;
            } else {
              // Otherwise just add a space for continuity
              result += " " + current;
            }
          }
        }
      }

      return result;
    }
  }

  // Legacy multipart helpers removed. All flows use buildMultipartBody now.

  /**
   * Transcribe an audio file
   * @param file The audio file to transcribe
   * @param context Optional transcription context
   * @returns Promise resolving to the transcription text
   */
  async transcribeFile(file: TFile, context?: TranscriptionContext): Promise<string> {
    const { promise, ahead } = this.transcriptionQueue.enqueue(() => this.processTranscription(file, context));
    this.debug("transcription enqueued", { filePath: file.path, ahead });

    if (ahead > 0) {
      const waitMessage =
        ahead === 1
          ? "Waiting for the previous transcription to finish..."
          : `Waiting for ${ahead} transcriptions ahead to finish...`;
      context?.onProgress?.(2, waitMessage);
    }

    return promise;
  }

  private async processTranscription(file: TFile, context?: TranscriptionContext): Promise<string> {
    const extension = file.extension.toLowerCase();
    if (!SUPPORTED_AUDIO_EXTENSIONS.includes(extension)) {
      throw new Error(`Unsupported file type: ${extension}`);
    }

    if (file.stat.size > MAX_FILE_SIZE) {
      throw new Error(`File too large. Maximum allowed size is ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))}MB.`);
    }

    try {
      this.info("Starting transcription pipeline", {
        filePath: file.path,
        size: file.stat.size,
        extension
      });

      const provider = this.plugin.settings.transcriptionProvider;
      const isMobile = this.platform.isMobile();

      if (
        provider === "systemsculpt" &&
        (!this.plugin.settings.licenseKey || !this.plugin.settings.licenseValid)
      ) {
        throw new Error(
          "A valid SystemSculpt license is required to use the SystemSculpt API for transcription. Please enter a valid license key or switch to a custom transcription provider in the settings."
        );
      }

      // Desktop: use the server-side jobs pipeline so we can handle large files reliably.
      if (provider === "systemsculpt" && !isMobile) {
        const transcriptionText = await this.transcribeViaSystemSculptJobs(file, context);
        context?.onProgress?.(100, "Transcription complete!");
        this.info("Transcription pipeline finished (server-side jobs)", {
          filePath: file.path,
          characters: transcriptionText.length,
        });
        return transcriptionText;
      }

      context?.onProgress?.(0, "Reading audio file...");

      let arrayBuffer: ArrayBuffer;
      try {
        arrayBuffer = await this.plugin.app.vault.readBinary(file);
        this.debug("Read audio file from vault", { filePath: file.path });
      } catch (readError) {
        try {
          const fs = require("fs");
          const path = require("path");

          let vaultPath = "";
          // @ts-ignore - basePath may exist on some adapter implementations
          if (this.plugin.app.vault.adapter.basePath) {
            // @ts-ignore
            vaultPath = this.plugin.app.vault.adapter.basePath;
          } else {
            const errorMatch = readError instanceof Error && readError.message.match(/open '(.+?)'/);

            if (errorMatch && errorMatch[1]) {
              const fullErrorPath = errorMatch[1];
              vaultPath = fullErrorPath.replace(new RegExp(`${file.path}$`), "");
              vaultPath = vaultPath.replace(/\/$/, "");
            }
          }

          if (!vaultPath) {
            throw new Error("Could not determine vault path");
          }

          const absolutePath = path.join(vaultPath, file.path);
          this.debug("Falling back to direct fs read", { absolutePath });

          arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
            fs.readFile(absolutePath, (err: any, data: Buffer) => {
              if (err) {
                reject(new Error(`Failed to read file directly: ${err.message}`));
                return;
              }
              const arrayCopy = new Uint8Array(data.byteLength);
              arrayCopy.set(data);
              resolve(arrayCopy.buffer);
            });
          });
        } catch (fsError) {
          throw new Error(
            `Failed to read audio file. Original error: ${
              readError instanceof Error ? readError.message : String(readError)
            }`
          );
        }
      }

      let processedArrayBuffer = arrayBuffer;
      let mimeType = MIME_TYPE_MAP[extension as keyof typeof MIME_TYPE_MAP];
      let wasResampled = false;

      if (provider === "custom" && !this.plugin.settings.customTranscriptionEndpoint?.trim()) {
        throw new Error(
          "Custom transcription endpoint is required when using a custom transcription provider. Configure it in Settings → SystemSculpt AI → Audio & Transcription."
        );
      }

      const directUploadLimitBytes =
        provider === "custom" ? CUSTOM_AUDIO_UPLOAD_MAX_BYTES : AUDIO_UPLOAD_MAX_BYTES;
      const chunkTargetSampleRate =
        provider === "custom" ? 16000 : EXPECTED_SAMPLE_RATES[extension] || 16000;

      const resamplingEnabled = this.plugin.settings.enableAutoAudioResampling ?? true;

      if (provider === "systemsculpt" && !isMobile && resamplingEnabled && file.stat.size <= AUDIO_UPLOAD_MAX_BYTES) {
        const targetSampleRate = EXPECTED_SAMPLE_RATES[extension] || 16000;

        try {
          context?.onProgress?.(10, "Checking audio compatibility...");
          this.debug("Checking audio compatibility", { targetSampleRate });

          const { needsResampling, currentSampleRate } = await this.audioResampler.checkNeedsResampling(
            arrayBuffer,
            mimeType,
            targetSampleRate
          );

          if (needsResampling) {
            context?.onProgress?.(15, "Converting audio format for optimal processing...");
            if (!context?.suppressNotices) {
              new Notice(
                `Audio needs conversion from ${currentSampleRate}Hz to ${targetSampleRate}Hz. This may take a moment...`,
                5000
              );
            }

            const startTime = Date.now();
            const resampleResult = await this.audioResampler.resampleAudio(arrayBuffer, targetSampleRate, mimeType);
            const resampleTime = Date.now() - startTime;

            processedArrayBuffer = resampleResult.buffer;
            mimeType = "audio/wav";
            wasResampled = true;

            if (resampleTime > 2000) {
              context?.onProgress?.(18, "Audio conversion complete!");
            }
            this.debug("Audio resampled", {
              targetSampleRate,
              durationMs: resampleTime
            });
          }
        } catch (resampleError) {
          if (!context?.suppressNotices) {
            new Notice("Audio format conversion failed. Attempting with original file...", 3000);
          }
            this.warn("Audio resampling failed", {
              error: resampleError instanceof Error ? resampleError.message : String(resampleError)
            });
          }
      } else if (provider === "systemsculpt" && isMobile) {
        try {
          const { needsResampling, currentSampleRate } = await this.audioResampler.checkNeedsResampling(
            arrayBuffer,
            mimeType,
            EXPECTED_SAMPLE_RATES[extension] || 16000
          );

          if (needsResampling) {
            if (!context?.suppressNotices) {
              new Notice(
                `⚠️ Audio format (${currentSampleRate}Hz) may not be compatible. Consider converting on desktop for best results.`,
                7000
              );
            }
          }
        } catch (e) {
          // Ignore check errors on mobile
        }
      }

      const shouldChunk = processedArrayBuffer.byteLength > directUploadLimitBytes;
      const transcriptionText = shouldChunk
        ? await this.transcribeChunkedAudio(
            file,
            processedArrayBuffer,
            {
              maxChunkBytes: directUploadLimitBytes,
              targetSampleRate: chunkTargetSampleRate,
            },
            context
          )
        : await this.queueTranscription(
            file,
            new Blob([processedArrayBuffer], { type: mimeType }),
            context,
            wasResampled
          );

      context?.onProgress?.(100, "Transcription complete!");
      this.info("Transcription pipeline finished", {
        filePath: file.path,
        characters: transcriptionText.length
      });

      return transcriptionText;
    } catch (error) {
      const catchedError = error instanceof Error ? error : new Error(String(error));

      const existingAdditionalInfo = (catchedError as any).additionalInfo;
      const currentFormDataVersionForCatch = "v2.9-native-fetch-ndjson";
      let finalAdditionalInfoToLog: any = {
        location: "transcribeFile catch block",
        originalErrorName: catchedError.name,
        formDataVersion: currentFormDataVersionForCatch,
        provider: this.plugin.settings.transcriptionProvider,
        file: { name: file.name, path: file.path, size: file.stat.size },
        ...(existingAdditionalInfo || {})
      };

      if (existingAdditionalInfo) {
        finalAdditionalInfoToLog.formDataVersion =
          existingAdditionalInfo.formDataVersion || currentFormDataVersionForCatch;
        finalAdditionalInfoToLog.provider =
          existingAdditionalInfo.provider || this.plugin.settings.transcriptionProvider;
      }

      await logMobileError(
        "TranscriptionService.transcribeFile",
        `Unhandled error in transcription process: ${catchedError.message}`,
        catchedError,
        finalAdditionalInfoToLog
      );

      if (!context?.suppressNotices) {
        new Notice(`Transcription failed: ${catchedError.message.substring(0, 120)}... (See debug log)`);
      }

      this.error("Transcription pipeline failed", catchedError, { filePath: file.path });
      throw catchedError;
    }
  }

  /**
   * Queue a transcription request to avoid rate limiting
   */
  private async queueTranscription(
    file: TFile,
    blob: Blob,
    context?: TranscriptionContext,
    wasResampled: boolean = false
  ): Promise<string> {
    this.debug("queueTranscription invoked", { filePath: file.path, wasResampled });
    // Check if we need to wait
    if (this.activeUploads >= this.maxConcurrentUploads) {
      this.debug("transcription queued behind active upload", {
        activeUploads: this.activeUploads
      });
      // Show user-friendly message about queueing
      const waitNotice = context?.suppressNotices
        ? null
        : new Notice(`Another transcription is in progress. Your file will be processed next...`, 0);
      
      // Update progress to show we're waiting
      context?.onProgress?.(20, "Waiting for previous transcription to complete...");
      
      // Wait with periodic updates
      let waitTime = 0;
      while (this.activeUploads >= this.maxConcurrentUploads) {
        await new Promise(resolve => setTimeout(resolve, 500));
        waitTime += 500;
        
        // Update wait message every 2 seconds
        if (waitTime % 2000 === 0) {
          context?.onProgress?.(20, `Waiting in queue (${Math.round(waitTime / 1000)}s)...`);
          this.debug("still waiting for upload slot", { waitMs: waitTime });
        }
      }
      
      // Remove wait notice
      waitNotice?.hide();
      
      // Show that we're starting now
      context?.onProgress?.(25, "Transcribing audio...");
    }

    this.activeUploads++;
    this.debug("transcription upload slot acquired", {
      filePath: file.path,
      activeUploads: this.activeUploads
    });
    
    try {
      // If file was resampled, adjust the progress message
      if (wasResampled) {
        context?.onProgress?.(30, "Uploading converted audio...");
      }
      
      // Process the transcription
      const result = await this.transcribeAudio(file, blob, context);
      this.info("transcribeAudio completed", { filePath: file.path });
      return result;
    } finally {
      this.activeUploads--;
      this.debug("transcription slot released", {
        filePath: file.path,
        activeUploads: this.activeUploads
      });
      
      // If there are more uploads waiting, log it
      if (this.transcriptionQueue.size > 0) {
        this.debug("pending transcriptions remain in queue", { queueSize: this.transcriptionQueue.size });
      }
    }
  }

  private getDiagnostics(): Record<string, unknown> {
    return {
      activeUploads: this.activeUploads,
      maxConcurrentUploads: this.maxConcurrentUploads,
      queueSize: this.transcriptionQueue.size,
      retryCount: this.retryCount
    };
  }

  private debug(message: string, data: Record<string, unknown> = {}): void {
    logDebug("TranscriptionService", message, { ...this.getDiagnostics(), ...data });
  }

  private info(message: string, data: Record<string, unknown> = {}): void {
    logInfo("TranscriptionService", message, { ...this.getDiagnostics(), ...data });
  }

  private warn(message: string, data: Record<string, unknown> = {}): void {
    logWarning("TranscriptionService", message, { ...this.getDiagnostics(), ...data });
  }

  private error(message: string, error: Error, data: Record<string, unknown> = {}): void {
    logError("TranscriptionService", `${message} ${JSON.stringify(data)}`, error);
  }

  unload() {
    // Clean up resources
    if (this.audioResampler) {
      this.audioResampler.dispose();
    }
  }
}
