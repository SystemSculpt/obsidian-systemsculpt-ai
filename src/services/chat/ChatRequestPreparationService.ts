import type { ChatMessage } from "../../types";
import type { OpenAITool } from "../../utils/tooling";
import type { ContextFileService } from "../ContextFileService";
import type { AcceptedChatOperation } from "../managed/ManagedTypes";
import {
  createAcceptedChatRequestSnapshot,
  type AcceptedChatPolicyAudit,
  type AcceptedChatRequestSnapshot,
} from "./AcceptedChatRequestSnapshot";

export type AcceptedChatPreparationSources = Readonly<{
  contextFiles: ReadonlySet<string>;
  selectedPrompt?: string;
  includeImages: boolean;
  tools: readonly OpenAITool[];
}>;

const services = new WeakMap<ContextFileService, ChatRequestPreparationService>();

export function prepareAcceptedChatRequest(
  contextFiles: ContextFileService,
  operation: AcceptedChatOperation,
  sources: AcceptedChatPreparationSources,
): Promise<AcceptedChatRequestSnapshot> {
  let service = services.get(contextFiles);
  if (!service) {
    service = new ChatRequestPreparationService(contextFiles);
    services.set(contextFiles, service);
  }
  return service.prepare(operation, sources);
}

export class ChatRequestPreparationService {
  private readonly pending = new WeakMap<AcceptedChatOperation, Promise<AcceptedChatRequestSnapshot>>();
  private readonly failed = new WeakSet<AcceptedChatOperation>();

  public constructor(private readonly contextFiles: ContextFileService) {}

  public prepare(operation: AcceptedChatOperation, sources: AcceptedChatPreparationSources): Promise<AcceptedChatRequestSnapshot> {
    const existing = this.pending.get(operation);
    if (existing) return existing;
    if (this.failed.has(operation)) return Promise.reject(new Error("Accepted Chat request preparation already failed."));
    const pending = this.prepareOnce(operation, sources).catch((error: Error) => {
      this.failed.add(operation);
      throw error;
    });
    this.pending.set(operation, pending);
    return pending;
  }

  public release(operation: AcceptedChatOperation): void {
    this.pending.delete(operation);
    this.failed.delete(operation);
  }

  private async prepareOnce(operation: AcceptedChatOperation, sources: AcceptedChatPreparationSources): Promise<AcceptedChatRequestSnapshot> {
    const contextFiles = new Set(sources.contextFiles);
    const preparedMessages = await this.contextFiles.prepareMessagesWithContext(
      operation.initialDurableSnapshot.messages.map((message) => ({ ...message })) as ChatMessage[],
      contextFiles,
      sources.includeImages,
      sources.selectedPrompt,
    );
    const audit: AcceptedChatPolicyAudit = {
      prompt: sources.selectedPrompt?.trim() ? "selected" : "none",
      contextCount: contextFiles.size,
      imageContextIncluded: sources.includeImages,
      documentContextIncluded: [...contextFiles].some((item) => item.startsWith("doc:")),
      tools: sources.tools.length > 0 ? "normalized" : "omitted",
    };
    return createAcceptedChatRequestSnapshot({ operation, preparedMessages, tools: sources.tools, policy: audit });
  }
}
