import { SystemSculptError, ERROR_CODES } from "../utils/errors";
import { errorLogger } from "../utils/errorLogger";
import { StreamPipeline } from "../streaming/StreamPipeline";
import type { StreamEvent, StreamPipelineDiagnostics, StreamPipelineOptions } from "../streaming/types";

export interface StreamResponseOptions extends StreamPipelineOptions {
  signal?: AbortSignal;
  onDiagnostics?: (diagnostics: StreamPipelineDiagnostics) => void;
}

export class StreamingService {
  public generateRequestId(): string {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch {}

    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 10);
    return `${timestamp}-${random}`;
  }

  public async *streamResponse(
    response: Response,
    options: StreamResponseOptions,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    if (!response.body) {
      throw new SystemSculptError(
        "Missing response body from streaming API",
        ERROR_CODES.STREAM_ERROR,
        response.status,
      );
    }

    const reader = response.body.getReader();
    const pipeline = new StreamPipeline({
      model: options.model,
      isCustomProvider: options.isCustomProvider,
      onRawEvent: options.onRawEvent,
    });

    const readWithAbort = async (): Promise<{ done: boolean; value?: Uint8Array; aborted: boolean }> => {
      if (!options.signal) {
        const { done, value } = await reader.read();
        return { done, value, aborted: false };
      }

      if (options.signal.aborted) {
        try {
          await reader.cancel();
        } catch {}
        return { done: true, value: undefined, aborted: true };
      }

      return await new Promise((resolve, reject) => {
        const onAbort = () => {
          try {
            void reader.cancel();
          } catch {}
          resolve({ done: true, value: undefined, aborted: true });
        };

        options.signal!.addEventListener("abort", onAbort, { once: true });

        reader
          .read()
          .then(({ done, value }) => resolve({ done, value, aborted: false }))
          .catch(reject)
          .finally(() => {
            options.signal!.removeEventListener("abort", onAbort);
          });
      });
    };

    try {
      let aborted = false;

      while (true) {
        const { done, value, aborted: abortedBySignal } = await readWithAbort();
        if (abortedBySignal) {
          aborted = true;
          break;
        }

        if (done) break;
        if (!value) continue;

        const { events, done: pipelineDone } = pipeline.push(value);
        for (const event of events) {
          yield event;
        }
        if (pipelineDone) break;
      }

      if (aborted) {
        try {
          options.onDiagnostics?.(pipeline.getDiagnostics());
        } catch {}
        return;
      }
    } catch (error) {
      try {
        errorLogger.error("StreamResponse read failure", error, {
          source: "StreamingService",
          method: "streamResponse",
        });
      } catch {}
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      throw error;
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }

    const trailingEvents = pipeline.flush();
    for (const event of trailingEvents) {
      yield event;
    }
    try {
      options.onDiagnostics?.(pipeline.getDiagnostics());
    } catch {}
  }
}
