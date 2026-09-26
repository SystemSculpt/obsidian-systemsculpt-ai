import type { App } from "obsidian";
import type SystemSculptPlugin from "../../../main";
import { ManagedDocumentProcessingAdapter } from "../../../services/managed/ManagedDocumentProcessingAdapter";
import { ManagedJobClient } from "../../../services/managed/ManagedJobClient";
import type { ManagedJobRecoveryStore } from "../../../services/managed/ManagedJobRecoveryStore";
import { isRetryableManagedJobObservationError } from "../../../services/managed/ManagedJobObservation";
import { getRuntimeCrypto } from "../../../utils/runtimeWindow";
import type { ChatDocumentAttachmentProcessor } from "./ChatMessageAttachments";

function createChatDocumentOperationId(): string {
  const crypto = getRuntimeCrypto();
  const random = crypto?.randomUUID?.().replace(/-/g, "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `chat-document-${random}`.slice(0, 128);
}

/**
 * Direct-byte PDF adapter for Chat. The source never becomes a vault file;
 * only the existing managed document job and recovery ledger see it.
 */
export class ManagedChatDocumentAttachmentProcessor implements ChatDocumentAttachmentProcessor {
  private readonly recovery: ManagedJobRecoveryStore;
  private readonly managed: ManagedDocumentProcessingAdapter;
  private readonly retries = new Map<string, Readonly<{ operationId: string; release: () => void }>>();

  public constructor(_app: App, plugin: SystemSculptPlugin) {
    const graph = plugin.getManagedCapabilityGraph();
    // The plugin's one recovery ledger, shared with every other managed job.
    this.recovery = graph.recovery;
    this.managed = new ManagedDocumentProcessingAdapter({
      admission: graph.admission,
      jobs: new ManagedJobClient(graph.transport).documents,
      recovery: this.recovery,
    });
  }

  public async prepare(input: Readonly<{
    name: string;
    mimeType: "application/pdf";
    bytes: ArrayBuffer;
    fingerprint: `sha256:${string}`;
  }>, options: Readonly<{ signal: AbortSignal }>): Promise<Readonly<{ operationId: string; markdown: string }>> {
    const retry = this.retries.get(input.fingerprint);
    retry?.release();
    this.retries.delete(input.fingerprint);
    const operationId = retry?.operationId ?? createChatDocumentOperationId();
    const source = {
      identity: `chat-pdf:${input.fingerprint.slice("sha256:".length)}`,
      fingerprint: () => input.fingerprint,
      load: async () => ({ filename: input.name, contentType: input.mimeType, bytes: input.bytes }),
    };
    try {
      const result = retry
        ? await this.managed.resume(operationId, { signal: options.signal, source })
        : await this.managed.process(source, { operationId, signal: options.signal });
      const markdown = typeof result.result.markdown === "string" && result.result.markdown.trim()
        ? result.result.markdown
        : result.result.text;
      if (typeof markdown !== "string" || !markdown.trim()) {
        throw new Error("Document processing returned no readable text.");
      }
      await this.managed.beginLocalCommit(operationId, options.signal);
      return Object.freeze({ operationId, markdown });
    } catch (error) {
      if (!options.signal.aborted && (retry || isRetryableManagedJobObservationError(error))) {
        // Retry observes the same admitted operation. A timeout never means
        // the server cancelled its job, and must not silently create another.
        const discard = () => {
          this.retries.delete(input.fingerprint);
          void this.discard(operationId).catch(() => undefined);
        };
        options.signal.addEventListener("abort", discard, { once: true });
        this.retries.set(input.fingerprint, {
          operationId,
          release: () => options.signal.removeEventListener("abort", discard),
        });
      } else {
        await this.discard(operationId).catch(() => undefined);
      }
      throw error;
    }
  }

  public async complete(operationId: string): Promise<void> {
    await this.managed.completeLocalCommit(operationId);
  }

  public async discard(operationId: string): Promise<void> {
    for (const [fingerprint, retry] of this.retries) {
      if (retry.operationId !== operationId) continue;
      retry.release();
      this.retries.delete(fingerprint);
    }
    let record;
    try {
      record = await this.recovery.read("document_processing", operationId);
    } catch {
      return;
    }
    if (record.phase === "completed") return;
    if (record.phase !== "abandoned") {
      record = await this.recovery.abandon("document_processing", operationId, record.revision);
    }
    await this.recovery.delete("document_processing", operationId, record.revision);
  }
}
