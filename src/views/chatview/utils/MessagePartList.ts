import type { MessagePart } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";

/**
 * MessagePartList – A lightweight helper around an array of MessagePart objects.
 *
 * This class centralises common queries (content, reasoning, tool-calls) and
 * string assembly so code can avoid repeating verbose filter/map logic.
 *
 * NOTE: The class is intentionally immutable – it never mutates the supplied
 * array.  For write-operations continue using the raw array until Phase 4
 * replaces direct manipulation with dedicated helpers.
 */
export class MessagePartList {
  readonly parts: MessagePart[];

  constructor(parts: MessagePart[]) {
    this.parts = Array.isArray(parts) ? parts : [];
  }

  /** Return all parts matching the given type */
  private _ofType<T extends MessagePart["type"]>(type: T): Extract<MessagePart, { type: T }>[] {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return this.parts.filter((p) => p.type === type) as any;
  }

  // ─────────────────────────── Query helpers ────────────────────────────
  /** Ordered array of *content* strings */
  public get contentParts(): string[] {
    return this._ofType("content").map((p) => p.data as string);
  }

  /** Ordered array of *reasoning* strings */
  public get reasoningParts(): string[] {
    return this._ofType("reasoning").map((p) => p.data as string);
  }

  /** Ordered array of tool-call payloads */
  public get toolCalls(): ToolCall[] {
    return this._ofType("tool_call").map((p) => p.data as ToolCall);
  }

  // ─────────────────────────── Convenience aggregations ─────────────────
  /** Concatenate content parts into a single markdown string */
  public contentMarkdown(delimiter = "\n\n"): string {
    return this.contentParts.join(delimiter);
  }

  /** Concatenate reasoning parts verbatim without extra separators */
  public reasoningMarkdown(delimiter = ""): string {
    return this.reasoningParts.join(delimiter);
  }

  /** Whether the list contains any reasoning segments */
  public get hasReasoning(): boolean {
    return this.reasoningParts.length > 0;
  }

  /** Whether the list contains any tool-calls */
  public get hasToolCalls(): boolean {
    return this.toolCalls.length > 0;
  }
} 