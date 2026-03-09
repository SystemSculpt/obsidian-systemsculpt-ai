import type SystemSculptPlugin from "../../main";
import type { StreamEvent } from "../../streaming/types";
import type { ChatMessage } from "../../types";
import {
  PiRpcProcessClient,
  type PiRpcMessageImage,
  type PiRpcThinkingLevel,
} from "../pi/PiRpcProcessClient";

type PiLocalSessionRef = {
  sessionFile?: string;
  sessionId: string;
};

type PiLocalAgentRunOptions = {
  plugin: SystemSculptPlugin;
  modelId: string;
  messages: ChatMessage[];
  systemPrompt?: string;
  signal?: AbortSignal;
  sessionFile?: string;
  reasoningEffort?: string;
  onSessionReady?: (session: PiLocalSessionRef) => void;
};

type QueueItem =
  | { kind: "event"; event: StreamEvent }
  | { kind: "done" }
  | { kind: "error"; error: Error };

type PiImageContent = PiRpcMessageImage;

function parseDataUrlImage(url: string): { mimeType: string; data: string } | null {
  const trimmed = String(url || "").trim();
  if (!trimmed.toLowerCase().startsWith("data:")) {
    return null;
  }

  const commaIndex = trimmed.indexOf(",");
  if (commaIndex <= 5) {
    return null;
  }

  const metadata = trimmed.slice(5, commaIndex);
  const payload = trimmed.slice(commaIndex + 1);
  if (!payload) {
    return null;
  }

  const parts = metadata
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const mimeType = parts[0]?.toLowerCase() || "";
  const isBase64 = parts.slice(1).some((part) => part.toLowerCase() === "base64");
  if (!mimeType.startsWith("image/") || !isBase64) {
    return null;
  }

  return {
    mimeType,
    data: payload,
  };
}

function toTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildPromptInput(messages: ChatMessage[]): { text: string; images: PiImageContent[] } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }

    const content = message.content;
    if (typeof content === "string") {
      return {
        text: content.trim(),
        images: [],
      };
    }

    if (!Array.isArray(content)) {
      return {
        text: toTextContent(content).trim(),
        images: [],
      };
    }

    const blockTexts: string[] = [];
    const images: PiImageContent[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        const text = block.text.trim();
        if (text) {
          blockTexts.push(text);
        }
        continue;
      }
      if (block.type === "image_url") {
        const parsed = parseDataUrlImage(String((block as any)?.image_url?.url || ""));
        if (parsed) {
          images.push({
            type: "image",
            data: parsed.data,
            mimeType: parsed.mimeType,
          });
        }
      }
    }

    return {
      text: blockTexts.join("\n\n").trim(),
      images,
    };
  }

  return {
    text: "",
    images: [],
  };
}

function extractAssistantContent(message: any): { text: string; reasoning: string } {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  let text = "";
  let reasoning = "";

  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
      continue;
    }
    if (block.type === "thinking") {
      if (typeof block.thinking === "string") {
        reasoning += block.thinking;
        continue;
      }
      if (typeof block.text === "string") {
        reasoning += block.text;
      }
    }
  }

  return { text, reasoning };
}

function extractAssistantErrorMessage(message: any): string {
  const stopReason = String(message?.stopReason || "").trim().toLowerCase();
  const errorMessage = String(message?.errorMessage || "").trim();
  if (errorMessage) {
    return errorMessage;
  }
  if (stopReason === "aborted") {
    return "Local Pi agent request was aborted.";
  }
  if (stopReason === "error") {
    return "Local Pi agent request failed.";
  }
  return "";
}

function normalizePiThinkingLevel(rawValue: unknown): PiRpcThinkingLevel | undefined {
  const normalized = String(rawValue || "").trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  return undefined;
}

export async function* streamPiLocalAgentTurn(
  options: PiLocalAgentRunOptions
): AsyncGenerator<StreamEvent, void, unknown> {
  const promptInput = buildPromptInput(options.messages);
  if (!promptInput.text && promptInput.images.length === 0) {
    throw new Error("Cannot start a local Pi turn without at least one user message.");
  }

  const client = new PiRpcProcessClient({
    plugin: options.plugin,
    modelId: options.modelId,
    thinkingLevel: normalizePiThinkingLevel(options.reasoningEffort),
    systemPrompt: options.systemPrompt,
    sessionFile: options.sessionFile,
  });

  await client.start();

  const state = await client.getState();
  const sessionFile =
    typeof state.sessionFile === "string" && state.sessionFile.trim().length > 0
      ? state.sessionFile.trim()
      : undefined;
  const sessionId = String(state.sessionId || "").trim();
  if (!sessionId) {
    await client.stop();
    throw new Error("Pi RPC session did not return a session id.");
  }

  options.onSessionReady?.({
    sessionFile,
    sessionId,
  });

  const queue: QueueItem[] = [];
  let waitingResolver: ((item: QueueItem) => void) | null = null;
  let streamedText = "";
  let streamedReasoning = "";
  let finished = false;

  const push = (item: QueueItem) => {
    if (finished && item.kind === "event") {
      return;
    }
    if (waitingResolver) {
      const resolve = waitingResolver;
      waitingResolver = null;
      resolve(item);
      return;
    }
    queue.push(item);
  };

  const emitRemainder = (kind: "content" | "reasoning", nextValue: string, currentValue: string): string => {
    if (!nextValue) {
      return currentValue;
    }

    if (!currentValue) {
      push({ kind: "event", event: { type: kind, text: nextValue } });
      return nextValue;
    }

    if (nextValue === currentValue) {
      return currentValue;
    }

    if (nextValue.startsWith(currentValue)) {
      const delta = nextValue.slice(currentValue.length);
      if (delta) {
        push({ kind: "event", event: { type: kind, text: delta } });
      }
      return nextValue;
    }

    return currentValue;
  };

  const unsubscribe = client.onEvent((event) => {
    const type = String(event.type || "").trim().toLowerCase();

    if (type === "message_update") {
      const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
      const assistantType = String(assistantEvent?.type || "").trim().toLowerCase();
      switch (assistantType) {
        case "text_delta": {
          const delta = String(assistantEvent?.delta || "");
          if (delta) {
            streamedText += delta;
            push({ kind: "event", event: { type: "content", text: delta } });
          }
          break;
        }
        case "thinking_delta": {
          const delta = String(assistantEvent?.delta || "");
          if (delta) {
            streamedReasoning += delta;
            push({ kind: "event", event: { type: "reasoning", text: delta } });
          }
          break;
        }
        case "toolcall_end": {
          const toolCall = assistantEvent?.toolCall as Record<string, unknown> | undefined;
          const id = String(toolCall?.id || "").trim();
          const name = String(toolCall?.name || "").trim();
          if (id && name) {
            const args =
              toolCall?.arguments && typeof toolCall.arguments === "object"
                ? toolCall.arguments
                : {};
            let serializedArguments = "{}";
            try {
              serializedArguments = JSON.stringify(args);
            } catch {
              serializedArguments = "{}";
            }

            push({
              kind: "event",
              event: {
                type: "tool-call",
                phase: "final",
                call: {
                  id,
                  index: typeof assistantEvent?.contentIndex === "number" ? assistantEvent.contentIndex : 0,
                  type: "function",
                  function: {
                    name,
                    arguments: serializedArguments,
                  },
                },
              },
            });
          }
          break;
        }
        case "error": {
          if (!options.signal?.aborted) {
            const errorMessage =
              String((assistantEvent as any)?.error?.errorMessage || "") ||
              "Local Pi agent error";
            push({
              kind: "error",
              error: new Error(errorMessage),
            });
          }
          break;
        }
        default:
          break;
      }
      return;
    }

    if (type === "message_end" && event.message && (event.message as any).role === "assistant") {
      const { text, reasoning } = extractAssistantContent(event.message);
      streamedText = emitRemainder("content", text, streamedText);
      streamedReasoning = emitRemainder("reasoning", reasoning, streamedReasoning);

      const errorMessage = extractAssistantErrorMessage(event.message);
      if (errorMessage && !options.signal?.aborted) {
        push({
          kind: "error",
          error: new Error(errorMessage),
        });
        return;
      }

      const stopReason = String((event.message as any)?.stopReason || "").trim();
      if (stopReason) {
        push({
          kind: "event",
          event: { type: "meta", key: "stop-reason", value: stopReason },
        });
      }
      return;
    }

    if (type === "auto_retry_start") {
      push({
        kind: "event",
        event: { type: "meta", key: "inline-footnote", value: "Retrying with Pi…" },
      });
      return;
    }

    if (type === "auto_compaction_start") {
      push({
        kind: "event",
        event: { type: "meta", key: "inline-footnote", value: "Pi is compacting the session…" },
      });
      return;
    }

    if (type === "agent_end") {
      finished = true;
      push({ kind: "done" });
    }
  });

  const onAbort = () => {
    void client.abort().catch(() => {});
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  void client
    .prompt(promptInput.text, promptInput.images.length > 0 ? promptInput.images : undefined)
    .catch((error: unknown) => {
      push({
        kind: "error",
        error: error instanceof Error ? error : new Error(String(error || "Local Pi turn failed.")),
      });
    });

  try {
    while (true) {
      const nextItem =
        queue.length > 0
          ? queue.shift()!
          : await new Promise<QueueItem>((resolve) => {
              waitingResolver = resolve;
            });

      if (nextItem.kind === "event") {
        yield nextItem.event;
        continue;
      }

      if (nextItem.kind === "error") {
        throw nextItem.error;
      }

      return;
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    await client.stop();
  }
}

export async function runPiLocalTextGeneration(options: {
  plugin: SystemSculptPlugin;
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  reasoningEffort?: string;
  signal?: AbortSignal;
}): Promise<{ text: string; modelId: string }> {
  const messages: ChatMessage[] = [{
    role: "user",
    content: options.prompt,
    message_id: "pi-local-user",
  } as ChatMessage];

  let text = "";
  for await (const event of streamPiLocalAgentTurn({
    plugin: options.plugin,
    modelId: options.modelId,
    messages,
    systemPrompt: options.systemPrompt,
    signal: options.signal,
    reasoningEffort: options.reasoningEffort,
  })) {
    if (event.type === "content") {
      text += event.text;
    }
  }

  return {
    text: text.trim(),
    modelId: options.modelId,
  };
}
