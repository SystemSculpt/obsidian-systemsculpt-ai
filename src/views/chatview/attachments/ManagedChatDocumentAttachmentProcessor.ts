import { Notice, type App } from "obsidian";
import type SystemSculptPlugin from "../../../main";
import { ManagedDocumentProcessingAdapter } from "../../../services/managed/ManagedDocumentProcessingAdapter";
import { ManagedJobClient } from "../../../services/managed/ManagedJobClient";
import { getRuntimeCrypto } from "../../../utils/runtimeWindow";
import type { ChatDocumentAttachmentProcessor } from "./ChatMessageAttachments";

function createChatDocumentOperationId(): string {
  const crypto = getRuntimeCrypto();
  const random = crypto?.randomUUID?.().replace(/-/g, "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `chat-document-${random}`.slice(0, 128);
}

function sourceIdentity(fingerprint: `sha256:${string}`): string {
  return `chat-pdf:${fingerprint.slice("sha256:".length)}`;
}

/**
 * Direct-byte PDF adapter for Chat. The source never becomes a vault file;
 * only the existing managed document job and recovery ledger see it. The
 * ledger keys each conversion by the PDF's bytes, so preparing the same bytes
 * again, after a failure, Stop, or reload, continues the retained conversion.
 */
export class ManagedChatDocumentAttachmentProcessor implements ChatDocumentAttachmentProcessor {
  private readonly managed: ManagedDocumentProcessingAdapter;
  /** Attempts still running, so a discard lands after their ledger writes. */
  private readonly running = new Map<string, Promise<unknown>>();

  public constructor(_app: App, plugin: SystemSculptPlugin) {
    const graph = plugin.getManagedCapabilityGraph();
    this.managed = new ManagedDocumentProcessingAdapter({
      admission: graph.admission,
      jobs: new ManagedJobClient(graph.transport).documents,
      // The plugin's one recovery ledger, shared with every other managed job.
      recovery: graph.recovery,
      createOperationId: createChatDocumentOperationId,
    });
  }

  public prepare(input: Readonly<{
    name: string;
    mimeType: "application/pdf";
    bytes: ArrayBuffer;
    fingerprint: `sha256:${string}`;
  }>, options: Readonly<{ signal: AbortSignal }>): Promise<Readonly<{ operationId: string; markdown: string }>> {
    const attempt = this.convert(input, options.signal);
    const settled = attempt.then(() => undefined, () => undefined);
    this.running.set(input.fingerprint, settled);
    void settled.then(() => {
      if (this.running.get(input.fingerprint) === settled) this.running.delete(input.fingerprint);
    });
    return attempt;
  }

  public async complete(operationId: string): Promise<void> {
    await this.managed.completeLocalCommit(operationId);
  }

  public async discard(fingerprint: `sha256:${string}`): Promise<void> {
    await this.running.get(fingerprint);
    await this.managed.discard(sourceIdentity(fingerprint));
  }

  private async convert(input: Parameters<ChatDocumentAttachmentProcessor["prepare"]>[0], signal: AbortSignal) {
    const converted = await this.managed.process({
      identity: sourceIdentity(input.fingerprint),
      fingerprint: () => input.fingerprint,
      load: async () => ({ filename: input.name, contentType: input.mimeType, bytes: input.bytes }),
    }, {
      signal,
      onNotice: (message) => new Notice(`${input.name}: ${message}`, 10_000),
    });
    const markdown = typeof converted.result.markdown === "string" && converted.result.markdown.trim()
      ? converted.result.markdown
      : converted.result.text;
    if (typeof markdown !== "string" || !markdown.trim()) {
      throw new Error("Document processing returned no readable text.");
    }
    await this.managed.beginLocalCommit(converted.operationId, signal);
    return Object.freeze({ operationId: converted.operationId, markdown });
  }
}
