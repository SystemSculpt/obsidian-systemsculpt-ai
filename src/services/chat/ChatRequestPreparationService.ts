import type { ChatMessage } from "../../types";
import { AGENT_PRESET } from "../../constants/prompts";
import { AGENT_TOOL_INSTRUCTIONS } from "../../constants/prompts/agent";
import { normalizeManagedTools, type ManagedToolDefinition } from "../../utils/tooling";
import type { ContextFileService } from "../ContextFileService";
import type {
  AcceptedChatOperation,
  AcceptedManagedChatOperation,
} from "../managed/ManagedTypes";
import {
  createAcceptedManagedChatRequestSnapshot,
  type AcceptedChatRequestSnapshot,
} from "./AcceptedChatRequestSnapshot";

export type ManagedChatPreparationInput = Readonly<{
  contextFiles?: ReadonlySet<string>;
  systemPromptOverride?: string;
  allowTools?: boolean;
}>;

export type ManagedChatPreparationDependencies = Readonly<{
  contextFileService: ContextFileService;
  getAvailableTools: () => Promise<Parameters<typeof normalizeManagedTools>[0]>;
}>;

export async function prepareManagedAcceptedChatRequest(
  operation: AcceptedManagedChatOperation,
  input: ManagedChatPreparationInput,
  dependencies: ManagedChatPreparationDependencies,
): Promise<Readonly<{ messages: readonly Readonly<ChatMessage>[]; tools: readonly ManagedToolDefinition[] }>> {
  const contextFiles = new Set(input.contextFiles ?? []);
  const toolsAllowed = input.allowTools !== false;
  const selectedPrompt = input.systemPromptOverride?.trim() || undefined;
  const prompt = selectedPrompt
    ? toolsAllowed
      ? `${selectedPrompt}\n\n${AGENT_TOOL_INSTRUCTIONS}`
      : selectedPrompt
    : toolsAllowed
      ? AGENT_PRESET.systemPrompt
      : undefined;
  const messages = await dependencies.contextFileService.prepareMessagesWithContext(
    operation.initialDurableSnapshot.messages.map((message) => ({ ...message })) as ChatMessage[],
    contextFiles,
    true,
    prompt,
  );
  const tools = toolsAllowed
    ? normalizeManagedTools(await dependencies.getAvailableTools())
    : [];
  return { messages, tools };
}

export class ChatRequestPreparationService {
  private readonly retained = new WeakMap<AcceptedChatOperation, Promise<AcceptedChatRequestSnapshot>>();
  private readonly failed = new WeakSet<AcceptedChatOperation>();
  public prepare(
    operation: AcceptedChatOperation,
    input: ManagedChatPreparationInput,
    managedDependencies: ManagedChatPreparationDependencies,
  ): Promise<AcceptedChatRequestSnapshot> {
    const existing = this.retained.get(operation);
    if (existing) return existing;
    if (this.failed.has(operation)) return Promise.reject(new Error("Accepted Chat request preparation already failed."));
    const contextFiles = new Set(input.contextFiles ?? []);
    const policyBase = {
      prompt: input.systemPromptOverride?.trim() ? "selected" as const : "none" as const,
      contextCount: contextFiles.size,
      imageContextIncluded: true,
      documentContextIncluded: [...contextFiles].some((item) => item.startsWith("doc:")),
    };
    const pending = prepareManagedAcceptedChatRequest(operation, input, managedDependencies)
      .then((managed) => createAcceptedManagedChatRequestSnapshot({
        operation,
        policy: {
          ...policyBase,
          tools: managed.tools.length ? "normalized" : "omitted",
        },
        managedMessages: managed.messages,
        managedTools: managed.tools,
      }))
      .catch((error: Error) => { this.failed.add(operation); throw error; });
    this.retained.set(operation, pending);
    return pending;
  }
  public release(operation: AcceptedChatOperation): void { this.retained.delete(operation); this.failed.delete(operation); }
  public has(operation: AcceptedChatOperation): boolean { return this.retained.has(operation); }
}
