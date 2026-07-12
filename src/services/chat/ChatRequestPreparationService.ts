import type { ChatMessage, SystemSculptModel } from "../../types";
import type { SystemSculptTextModelSourceMode } from "../../types/llm";
import { AGENT_PRESET } from "../../constants/prompts";
import { AGENT_TOOL_INSTRUCTIONS } from "../../constants/prompts/agent";
import { getImageCompatibilityInfo } from "../../utils/modelUtils";
import { normalizeOpenAITools, type OpenAITool } from "../../utils/tooling";
import type { PreparedChatRequest } from "../StreamExecutionTypes";
import type { ContextFileService } from "../ContextFileService";
import type { AcceptedChatOperation } from "../managed/ManagedTypes";
import { createAcceptedChatRequestSnapshot, type AcceptedChatPolicyAudit, type AcceptedChatRequestSnapshot } from "./AcceptedChatRequestSnapshot";

export type ChatPreparationNotice = Readonly<{ kind: "image_incompatible"; modelKey: string; message: string; timeoutMs: 7000 }>;
export type ChatPreparationDiagnostic = Readonly<{ kind: "tool_resolution_failed"; model: string; actualModelId: string; message: string }>;
export type AuthoritativeChatPreparation = Readonly<{
  prepared: PreparedChatRequest;
  notices: readonly ChatPreparationNotice[];
  diagnostics: readonly ChatPreparationDiagnostic[];
}>;

export type AuthoritativeChatPreparationInput = Readonly<{
  messages: readonly Readonly<ChatMessage>[];
  model: string;
  contextFiles?: ReadonlySet<string>;
  systemPromptOverride?: string;
  transientSystemPromptSuffix?: string;
  allowTools?: boolean;
}>;

export type ChatPreparationDependencies = Readonly<{
  contextFileService: ContextFileService;
  getModelInfo: (model: string) => Promise<Readonly<{ modelSource: SystemSculptTextModelSourceMode; actualModelId: string; model?: SystemSculptModel }>>;
  getAvailableTools: () => Promise<Parameters<typeof normalizeOpenAITools>[0]>;
  countImageContextFiles: (files: ReadonlySet<string>) => number;
}>;

function fallbackModel(model: string, modelSource: SystemSculptTextModelSourceMode, actualModelId: string): SystemSculptModel {
  const providerId = actualModelId.split("/")[0] || "unknown";
  const providerModelId = actualModelId.split("/").slice(1).join("/") || actualModelId;
  return {
    id: model, name: providerModelId, description: "", provider: providerId, sourceMode: modelSource,
    sourceProviderId: providerId, identifier: { providerId, modelId: providerModelId, displayName: providerModelId },
    piExecutionModelId: actualModelId, piAuthMode: "local", piRemoteAvailable: false, piLocalAvailable: true,
    context_length: 0, capabilities: [], architecture: { modality: "text->text", tokenizer: "", instruct_type: null },
    pricing: { prompt: "0", completion: "0", image: "0", request: "0" },
  } as SystemSculptModel;
}

export async function prepareChatRequestAuthoritatively(
  input: AuthoritativeChatPreparationInput,
  dependencies: ChatPreparationDependencies,
  messagesAlreadyPrepared = false,
  preResolvedTools?: readonly OpenAITool[],
): Promise<AuthoritativeChatPreparation> {
  const modelInfo = await dependencies.getModelInfo(input.model);
  const { modelSource, actualModelId } = modelInfo;
  const resolvedModel = modelInfo.model ?? fallbackModel(input.model, modelSource, actualModelId);
  const contextFiles = new Set(input.contextFiles ?? []);
  const imageContextCount = dependencies.countImageContextFiles(contextFiles);
  const notices: ChatPreparationNotice[] = [];
  let imagesEnabledForRequest = true;
  if (imageContextCount > 0) {
    const compatibility = getImageCompatibilityInfo(resolvedModel);
    if (!compatibility.isCompatible && compatibility.confidence === "high") {
      imagesEnabledForRequest = false;
      const imageLabel = imageContextCount === 1 ? "image attachment" : "image attachments";
      notices.push({ kind: "image_incompatible", modelKey: resolvedModel.id || actualModelId || input.model, timeoutMs: 7000,
        message: `Selected model does not support image input. Sending message without ${imageContextCount} ${imageLabel}. Switch to a vision-capable model to include images.` });
    }
  }

  const toolsAllowed = input.allowTools !== false;
  const toolCapableModelSource = modelSource === "systemsculpt" || modelSource === "custom_endpoint";
  let finalSystemPrompt: string | undefined;
  if (input.systemPromptOverride?.trim()) {
    finalSystemPrompt = toolsAllowed && toolCapableModelSource
      ? `${input.systemPromptOverride.trim()}\n\n${AGENT_TOOL_INSTRUCTIONS}`
      : input.systemPromptOverride.trim();
  } else if (toolsAllowed && modelSource === "systemsculpt") finalSystemPrompt = AGENT_PRESET.systemPrompt;
  else if (toolsAllowed && modelSource === "custom_endpoint") finalSystemPrompt = AGENT_TOOL_INSTRUCTIONS;
  const suffix = input.transientSystemPromptSuffix?.trim() ?? "";
  if (suffix) finalSystemPrompt = finalSystemPrompt ? `${finalSystemPrompt.trim()}\n\n${suffix}` : suffix;

  const diagnostics: ChatPreparationDiagnostic[] = [];
  let tools: OpenAITool[] = [];
  if (toolsAllowed && toolCapableModelSource && resolvedModel.supported_parameters?.includes("tools")) {
    try { tools = preResolvedTools ? [...preResolvedTools] : normalizeOpenAITools(await dependencies.getAvailableTools()); }
    catch (error) {
      void error;
      diagnostics.push({ kind: "tool_resolution_failed", model: input.model, actualModelId, message: "Tool definition resolution failed." });
    }
  }
  const preparedMessages = messagesAlreadyPrepared
    ? input.messages.map((message) => ({ ...message })) as ChatMessage[]
    : await dependencies.contextFileService.prepareMessagesWithContext(
      input.messages.map((message) => ({ ...message })) as ChatMessage[], contextFiles, imagesEnabledForRequest, finalSystemPrompt,
    );
  return { prepared: { modelSource, resolvedModel, actualModelId, preparedMessages, finalSystemPrompt: finalSystemPrompt ?? "", tools }, notices, diagnostics };
}

export type ManagedChatPreparationDependencies = Readonly<{
  contextFileService: ContextFileService;
  getAvailableTools: () => Promise<Parameters<typeof normalizeOpenAITools>[0]>;
}>;

export async function prepareManagedAcceptedChatRequest(
  operation: AcceptedChatOperation,
  input: Pick<AuthoritativeChatPreparationInput, "contextFiles" | "systemPromptOverride" | "allowTools">,
  dependencies: ManagedChatPreparationDependencies,
): Promise<Readonly<{ messages: readonly Readonly<ChatMessage>[]; tools: readonly OpenAITool[] }>> {
  const contextFiles = new Set(input.contextFiles ?? []);
  const prompt = input.systemPromptOverride?.trim() || undefined;
  const messages = await dependencies.contextFileService.prepareMessagesWithContext(
    operation.initialDurableSnapshot.messages.map((message) => ({ ...message })) as ChatMessage[],
    contextFiles,
    true,
    prompt,
  );
  const tools = input.allowTools === false ? [] : normalizeOpenAITools(await dependencies.getAvailableTools());
  return { messages, tools };
}

export class ChatRequestPreparationService {
  private readonly retained = new WeakMap<AcceptedChatOperation, Promise<AcceptedChatRequestSnapshot>>();
  private readonly failed = new WeakSet<AcceptedChatOperation>();
  public prepare(
    operation: AcceptedChatOperation,
    input: AuthoritativeChatPreparationInput,
    dependencies: ChatPreparationDependencies,
    _managedDependencies: ManagedChatPreparationDependencies,
  ): Promise<AcceptedChatRequestSnapshot> {
    const existing = this.retained.get(operation);
    if (existing) return existing;
    if (this.failed.has(operation)) return Promise.reject(new Error("Accepted Chat request preparation already failed."));
    const pending = prepareChatRequestAuthoritatively(input, dependencies)
      .then((legacy) => ({
        legacy,
        managed: { messages: legacy.prepared.preparedMessages, tools: legacy.prepared.tools },
      }))
      .then(({ legacy, managed }) => {
        const contextFiles = new Set(input.contextFiles ?? []);
        const policy: AcceptedChatPolicyAudit = {
          prompt: input.systemPromptOverride?.trim() ? "selected" : "none", contextCount: contextFiles.size,
          imageContextIncluded: true,
          documentContextIncluded: [...contextFiles].some((item) => item.startsWith("doc:")), tools: managed.tools.length ? "normalized" : "omitted",
        };
        return createAcceptedChatRequestSnapshot({ operation, preparation: legacy, policy, managedMessages: managed.messages, managedTools: managed.tools });
      })
      .catch((error: Error) => { this.failed.add(operation); throw error; });
    this.retained.set(operation, pending);
    return pending;
  }
  public release(operation: AcceptedChatOperation): void { this.retained.delete(operation); this.failed.delete(operation); }
  public has(operation: AcceptedChatOperation): boolean { return this.retained.has(operation); }
}
