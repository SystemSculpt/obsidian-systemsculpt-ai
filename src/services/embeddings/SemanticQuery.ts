import type { ChatMessage } from "../../types";
import { MANAGED_EMBEDDING_LIMITS } from "./ManagedEmbeddingsContract";

const FRAGMENT_SEPARATOR = "\n\n";
const EXCERPT_SEPARATOR = "\n…\n";

function normalizeFragment(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function excerptFragment(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= EXCERPT_SEPARATOR.length) return text.slice(0, maxChars);

  const available = maxChars - EXCERPT_SEPARATOR.length;
  const headLength = Math.ceil(available * 0.6);
  const tailLength = available - headLength;
  return `${text.slice(0, headLength)}${EXCERPT_SEPARATOR}${text.slice(text.length - tailLength)}`;
}

/**
 * Builds one deterministic semantic input while retaining evidence from every
 * supplied fragment. Oversized fragments contribute a stable head/tail excerpt
 * and unused space from short fragments flows to the remaining fragments.
 */
function buildBoundedSemanticQuery(
  fragments: readonly unknown[],
  maxChars = MANAGED_EMBEDDING_LIMITS.maxCharsPerText,
): string {
  const normalized = fragments.map(normalizeFragment).filter(Boolean);
  if (normalized.length === 0 || !Number.isFinite(maxChars) || maxChars <= 0) return "";

  const boundedMax = Math.max(1, Math.floor(maxChars));
  const joined = normalized.join(FRAGMENT_SEPARATOR);
  if (joined.length <= boundedMax) return joined;

  // Similar Notes currently supplies at most a few dozen fragments. Keep the
  // fallback deterministic if a future caller supplies more fragments than can
  // fit alongside separators by sampling the ordered set across its full span.
  const maxFragmentCount = Math.max(1, Math.floor((boundedMax + FRAGMENT_SEPARATOR.length) / (FRAGMENT_SEPARATOR.length + 1)));
  const retained = normalized.length <= maxFragmentCount
    ? normalized
    : Array.from({ length: maxFragmentCount }, (_, index) => {
        const sourceIndex = Math.floor((index * (normalized.length - 1)) / Math.max(1, maxFragmentCount - 1));
        return normalized[sourceIndex];
      });

  let remaining = boundedMax - FRAGMENT_SEPARATOR.length * (retained.length - 1);
  const excerpts: string[] = [];
  for (let index = 0; index < retained.length; index += 1) {
    const remainingFragments = retained.length - index;
    const fairShare = Math.max(1, Math.floor(remaining / remainingFragments));
    const excerpt = excerptFragment(retained[index], fairShare);
    excerpts.push(excerpt);
    remaining -= excerpt.length;
  }
  return excerpts.join(FRAGMENT_SEPARATOR).slice(0, boundedMax);
}

export function buildNoteSemanticQuery(content: string): string {
  return buildBoundedSemanticQuery([content]);
}

function chatRoleLabel(role: ChatMessage["role"]): string {
  switch (role) {
    case "assistant": return "Assistant";
    case "system": return "System";
    case "tool": return "Tool";
    default: return "User";
  }
}

function selectedChatMessages(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  if (messages.length <= 5) return messages;
  return [...messages.slice(0, 3), ...messages.slice(-2)];
}

/**
 * Builds the Similar Notes query from the established first-three/latest-two
 * turn window. Each textual multipart item is a separate fragment, so pasted
 * text and extracted document content remain represented without embedding
 * image data URLs.
 */
export function buildChatSemanticQuery(messages: readonly ChatMessage[]): string {
  const fragments: string[] = [];
  for (const message of selectedChatMessages(messages)) {
    const label = chatRoleLabel(message.role);
    if (typeof message.content === "string") {
      if (message.content.trim()) fragments.push(`${label}:\n${message.content}`);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    const textParts = message.content.filter((part): part is Extract<typeof part, { type: "text" }> => (
      part?.type === "text" && Boolean(part.text.trim())
    ));
    textParts.forEach((part, index) => {
      const partLabel = textParts.length > 1 ? `${label} part ${index + 1}` : label;
      fragments.push(`${partLabel}:\n${part.text}`);
    });
  }
  return buildBoundedSemanticQuery(fragments);
}
