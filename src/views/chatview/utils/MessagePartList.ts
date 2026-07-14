import type { MessagePart } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";

/** Immutable queries used by the durable markdown serializer. */
export class MessagePartList {
  constructor(public readonly parts: readonly MessagePart[]) {}

  public get contentParts(): string[] {
    return this.parts.filter((part) => part.type === "content").map((part) => String(part.data ?? ""));
  }

  public get reasoningParts(): string[] {
    return this.parts.filter((part) => part.type === "reasoning").map((part) => String(part.data ?? ""));
  }

  public get toolCalls(): ToolCall[] {
    return this.parts
      .filter((part): part is Extract<MessagePart, { type: "tool_call" }> => part.type === "tool_call")
      .map((part) => part.data);
  }

  public contentMarkdown(delimiter = "\n\n"): string { return this.contentParts.join(delimiter); }
  public reasoningMarkdown(delimiter = ""): string { return this.reasoningParts.join(delimiter); }
  public get hasReasoning(): boolean { return this.reasoningParts.length > 0; }
  public get hasToolCalls(): boolean { return this.toolCalls.length > 0; }
}
