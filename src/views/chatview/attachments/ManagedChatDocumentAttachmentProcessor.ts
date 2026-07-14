import type { App } from "obsidian";
import type SystemSculptPlugin from "../../../main";
import { ManagedDocumentProcessingAdapter } from "../../../services/managed/ManagedDocumentProcessingAdapter";
import { ManagedJobClient } from "../../../services/managed/ManagedJobClient";
import { ManagedJobRecoveryStore } from "../../../services/managed/ManagedJobRecoveryStore";
import { ObsidianManagedRecoveryAdapter } from "../../../services/managed/adapters/ObsidianManagedRecoveryAdapter";
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

  public constructor(app: App, plugin: SystemSculptPlugin) {
    const graph = plugin.getManagedCapabilityGraph();
    this.recovery = new ManagedJobRecoveryStore(new ObsidianManagedRecoveryAdapter(app));
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
  }>): Promise<Readonly<{ operationId: string; markdown: string }>> {
    const operationId = createChatDocumentOperationId();
    try {
      const result = await this.managed.process({
        identity: `chat-pdf:${input.fingerprint.slice("sha256:".length)}`,
        fingerprint: () => input.fingerprint,
        load: async () => ({ filename: input.name, contentType: input.mimeType, bytes: input.bytes }),
      }, { operationId });
      const markdown = typeof result.result.markdown === "string" && result.result.markdown.trim()
        ? result.result.markdown
        : result.result.text;
      if (typeof markdown !== "string" || !markdown.trim()) {
        throw new Error("Document processing returned no readable text.");
      }
      await this.managed.beginLocalCommit(operationId);
      return Object.freeze({ operationId, markdown });
    } catch (error) {
      await this.discard(operationId).catch(() => undefined);
      throw error;
    }
  }

  public async complete(operationId: string): Promise<void> {
    await this.managed.completeLocalCommit(operationId);
  }

  public async discard(operationId: string): Promise<void> {
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
