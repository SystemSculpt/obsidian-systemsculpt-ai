import type { ChatMessage, MultiPartContent } from "../../types";
import { parseAttachedTextContent } from "../../chat/ChatAttachmentContent";
import { readManagedToolCallFunction } from "../../chat/managed/ManagedToolExecution";
import { isRecord } from "../../studio/utils";

/** Input fields that name what a tool acted on; the first one present wins (a command before its description). */
const TOOL_TARGET_FIELDS = ["command", "file_path", "notebook_path", "path", "url", "query", "pattern", "description"] as const;
const TOOL_LINE_LENGTH = 200;

/** A message's visible text, or a short note (tool call, attachment, outcome) that sits on its own line. */
type ReplayLine = { text: string; note?: true };

function oneLine(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > TOOL_LINE_LENGTH ? `${line.slice(0, TOOL_LINE_LENGTH - 1)}…` : line;
}

function toolTarget(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const field of TOOL_TARGET_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.length && value.every((word) => typeof word === "string")) return value.join(" ");
  }
  const changed = Array.isArray(input.changes)
    ? input.changes.flatMap((change) => isRecord(change) && typeof change.path === "string" ? [change.path] : [])
    : [];
  return changed.length ? changed.join(", ") : undefined;
}

function toolOutcome(call: Record<string, unknown>): string | undefined {
  const result = isRecord(call.result) ? call.result : {};
  if (result.success === true) return undefined;
  const code = isRecord(result.error) && typeof result.error.code === "string" ? result.error.code : "";
  if (call.approvalDecision === "denied" || code.includes("DENIED")) return "denied";
  if (call.approvalDecision === "withdrawn" || code.includes("CANCEL")) return "cancelled";
  if (code === "NATIVE_TOOL_OUTCOME_UNKNOWN") return undefined;
  return result.success === false || call.state === "failed" ? "failed" : undefined;
}

/** One line per tool call: its name and target. Inputs and outputs stay with the session that ran it. */
function toolLine(call: unknown): string | undefined {
  const fn = readManagedToolCallFunction(call);
  if (!fn || !isRecord(call)) return undefined;
  let input: unknown;
  try { input = JSON.parse(fn.arguments); } catch { input = undefined; }
  const target = toolTarget(input), outcome = toolOutcome(call);
  return `[Tool: ${oneLine(target ? `${fn.name} ${target}` : fn.name)}${outcome ? ` (${outcome})` : ""}]`;
}

/** The text the chat shows for message content, and a line for each attachment it shows as a chip. */
function presentContent(content: string | MultiPartContent[] | null | undefined, text: ReplayLine[], attachments: ReplayLine[] | null): void {
  if (typeof content === "string") {
    if (content.trim()) text.push({ text: content.trim() });
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "image_url") {
      attachments?.push({ text: "Attached image", note: true });
      continue;
    }
    if (part.type !== "text" || typeof part.text !== "string") continue;
    const attached = parseAttachedTextContent(part.text);
    if (attached) attachments?.push({ text: `Attached file: ${attached.name}`, note: true });
    else if (part.text.trim()) text.push({ text: part.text.trim() });
  }
}

function presentMessage(message: Readonly<ChatMessage>): ReplayLine[] {
  const lines: ReplayLine[] = [];
  if (message.role === "user") {
    const metadata = message.attachmentMetadata?.length ? [...message.attachmentMetadata].sort((left, right) => left.contentPartIndex - right.contentPartIndex) : null;
    const attachments: ReplayLine[] = metadata ? metadata.map((item) => ({ text: `Attached ${item.kind === "image" ? "image" : "file"}: ${item.name}`, note: true })) : [];
    presentContent(message.content, lines, metadata ? null : attachments);
    return [...lines, ...attachments];
  }
  // Durable parts are the chronology the chat renders; reasoning is not part of the conversation.
  if (message.messageParts?.length) {
    for (const part of [...message.messageParts].sort((left, right) => left.timestamp - right.timestamp)) {
      if (part.type === "content") {
        const attachments: ReplayLine[] = [];
        presentContent(part.data, lines, attachments);
        lines.push(...attachments);
      } else if (part.type === "tool_call") {
        const line = toolLine(part.data);
        if (line) lines.push({ text: line, note: true });
      }
    }
  } else {
    presentContent(message.content, lines, null);
  }
  if (lines.length && message.terminalOutcome) lines.push({ text: message.terminalOutcome === "cancelled" ? "[Stopped before finishing]" : "[Failed before finishing]", note: true });
  return lines;
}

/**
 * The earlier chat for a native session that starts over after Retry or an
 * edit, as the person saw it: each message's role and visible text, attachment
 * names, and one line per tool call. Tool inputs and outputs are left out.
 */
export function localAgentReplay(history: readonly Readonly<ChatMessage>[]): string {
  const blocks: { role: "user" | "assistant"; lines: ReplayLine[] }[] = [];
  for (const message of history) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const lines = presentMessage(message);
    if (!lines.length) continue;
    const previous = blocks[blocks.length - 1];
    if (previous?.role === message.role) previous.lines.push(...lines);
    else blocks.push({ role: message.role, lines });
  }
  if (!blocks.length) return "";
  return [
    "Earlier messages in this chat, as the person saw them. Tool results are left out; use your tools again if you need them.",
    ...blocks.map(({ role, lines }) => `${role === "user" ? "User" : "Assistant"}:\n${lines
      .map((line, index) => `${index === 0 ? "" : line.note && lines[index - 1].note ? "\n" : "\n\n"}${line.text}`).join("")}`),
  ].join("\n\n");
}
