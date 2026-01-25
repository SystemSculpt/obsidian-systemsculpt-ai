import type { StreamEvent } from "../../../streaming/types";
import type { MessagePart } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";

export interface TranscriptSummary {
  parts: MessagePart[];
  content: string;
  reasoning: string;
}

export class TranscriptAssembler {
  private parts: MessagePart[] = [];
  private lastTimestamp = 0;
  private pendingContent = "";
  private finalContent = "";
  private finalReasoning = "";
  private activeReasoningIndex: number | null = null;

  begin(seedParts?: MessagePart[]): void {
    this.parts = [];
    this.lastTimestamp = 0;
    this.pendingContent = "";
    this.finalContent = "";
    this.finalReasoning = "";
    this.activeReasoningIndex = null;

    if (!Array.isArray(seedParts) || seedParts.length === 0) {
      return;
    }

    // Shallow-clone parts so we can mutate timestamps/data during streaming without
    // accidentally mutating the caller's array. ToolCall objects are intentionally
    // not deep-cloned so their state stays in sync with the ToolCallManager.
    const cloned = seedParts.map((part) => ({ ...part } as MessagePart));
    cloned.sort((a, b) => a.timestamp - b.timestamp);

    this.parts = cloned;
    this.lastTimestamp = cloned.reduce((acc, part) => Math.max(acc, part.timestamp ?? 0), 0);
    this.finalContent = this.extractContentFromParts(cloned);
    this.finalReasoning = this.extractReasoningFromParts(cloned);

    const lastPart = cloned.length > 0 ? cloned[cloned.length - 1] : null;
    if (lastPart?.type === "reasoning") {
      this.activeReasoningIndex = cloned.length - 1;
    }
  }

  apply(event: StreamEvent): void {
    switch (event.type) {
      case "reasoning":
        this.flushPendingContent(false);
        this.appendReasoning(event.text);
        break;
      case "content":
        this.activeReasoningIndex = null;
        this.pendingContent += event.text;
        this.flushPendingContent(false);
        break;
      case "tool-call":
        // Tool calls are attached separately once the ToolCallManager creates them.
        this.flushPendingContent(true);
        this.activeReasoningIndex = null;
        break;
      case "meta":
      case "footnote":
      default:
        // No-op for assembler; meta events are handled by the controller.
        break;
    }
  }

  attachToolCall(toolCall: ToolCall): void {
    this.flushPendingContent(true);
    this.activeReasoningIndex = null;

    const timestamp = this.nextTimestamp(Math.max(toolCall.timestamp ?? Date.now(), this.lastTimestamp + 1));
    toolCall.timestamp = timestamp;

    const existingIndex = this.parts.findIndex(
      (part) => part.type === "tool_call" && (part.data as ToolCall).id === toolCall.id,
    );

    if (existingIndex !== -1) {
      this.parts[existingIndex] = {
        id: this.parts[existingIndex].id,
        type: "tool_call",
        timestamp,
        data: toolCall,
      };
      return;
    }

    this.parts.push({
      id: `tool_call_part-${toolCall.id}`,
      type: "tool_call",
      timestamp,
      data: toolCall,
    });
  }

  getParts(): MessagePart[] {
    return this.parts;
  }

  finalize(): TranscriptSummary {
    this.flushPendingContent(true);
    return {
      parts: this.parts,
      content: this.finalContent,
      reasoning: this.finalReasoning,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────────────────────────────────

  private appendReasoning(text: string): void {
    if (!text) return;
    this.finalReasoning += text;

    if (this.activeReasoningIndex == null) {
      const timestamp = this.nextTimestamp();
      this.parts.push({
        id: `reasoning-${timestamp}`,
        type: "reasoning",
        timestamp,
        data: text,
      });
      this.activeReasoningIndex = this.parts.length - 1;
      return;
    }

    const existing = this.parts[this.activeReasoningIndex];
    if (existing && existing.type === "reasoning") {
      existing.data += text;
      existing.timestamp = this.nextTimestamp(existing.timestamp);
    } else {
      const timestamp = this.nextTimestamp();
      this.parts.push({
        id: `reasoning-${timestamp}`,
        type: "reasoning",
        timestamp,
        data: text,
      });
      this.activeReasoningIndex = this.parts.length - 1;
    }
  }

  private flushPendingContent(force: boolean): void {
    if (!this.pendingContent) return;

    if (!force) {
      const newlineIndex = this.pendingContent.lastIndexOf("\n");
      let flushText: string;
      if (newlineIndex === -1) {
        // No newline yet—flush the entire buffer so streaming appears live.
        // Subsequent chunks will merge into the same last content part.
        flushText = this.pendingContent;
        this.pendingContent = "";
      } else {
        flushText = this.pendingContent.slice(0, newlineIndex + 1);
        this.pendingContent = this.pendingContent.slice(newlineIndex + 1);
      }
      if (flushText.length > 0) {
        this.appendContent(flushText);
      }
      return;
    }

    const flushText = this.pendingContent;
    this.pendingContent = "";
    if (flushText.length > 0) {
      this.appendContent(flushText);
    }
  }

  private appendContent(text: string): void {
    if (!text) return;

    this.finalContent += text;

    const lastPart = this.parts.length > 0 ? this.parts[this.parts.length - 1] : null;
    if (lastPart && lastPart.type === "content" && typeof lastPart.data === "string") {
      lastPart.data += text;
      lastPart.timestamp = this.nextTimestamp(lastPart.timestamp);
      return;
    }

    const timestamp = this.nextTimestamp();
    this.parts.push({
      id: `content-${timestamp}`,
      type: "content",
      timestamp,
      data: text,
    });
  }

  private nextTimestamp(seed?: number): number {
    const candidate = seed ?? Date.now();
    const ts = Math.max(candidate, this.lastTimestamp + 1);
    this.lastTimestamp = ts;
    return ts;
  }

  private extractContentFromParts(parts: MessagePart[]): string {
    let text = "";

    for (const part of parts) {
      if (part.type !== "content") continue;

      const data: any = part.data;
      if (typeof data === "string") {
        text += data;
        continue;
      }

      if (Array.isArray(data)) {
        for (const chunk of data) {
          if (chunk?.type === "text" && typeof chunk.text === "string") {
            text += chunk.text;
          }
        }
        continue;
      }

      if (data != null) {
        text += String(data);
      }
    }

    return text;
  }

  private extractReasoningFromParts(parts: MessagePart[]): string {
    let text = "";

    for (const part of parts) {
      if (part.type !== "reasoning") continue;
      if (typeof part.data === "string") {
        text += part.data;
      }
    }

    return text;
  }
}
