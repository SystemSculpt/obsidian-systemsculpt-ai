import { deterministicId } from "./id";

export interface ToolCallIdState {
  rawToSanitized: Map<string, string>;
  usedIds: Set<string>;
}

export function createToolCallIdState(): ToolCallIdState {
  return {
    rawToSanitized: new Map(),
    usedIds: new Set(),
  };
}

export function sanitizeToolCallId(
  rawId: string | undefined,
  index: number,
  state: ToolCallIdState
): string {
  const baseKey = rawId ?? `index_${index}`;

  if (state.rawToSanitized.has(baseKey)) {
    return state.rawToSanitized.get(baseKey)!;
  }

  let candidate: string;

  if (rawId && isValidToolCallId(rawId) && !state.usedIds.has(rawId)) {
    candidate = rawId;
  } else {
    candidate = generateToolCallId(rawId, index);
    while (state.usedIds.has(candidate)) {
      candidate = generateToolCallId(undefined, index);
    }
  }

  state.usedIds.add(candidate);
  state.rawToSanitized.set(baseKey, candidate);
  return candidate;
}

function isValidToolCallId(id: string): boolean {
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (trimmed.length === 0) return false;

  // Keep IDs stable across providers (OpenAI uses call_*, OpenRouter/Gemini uses tool_*,
  // Anthropic uses toolu_*, and some gateways emit custom prefixes). We only reject
  // obviously unsafe shapes (whitespace, extremely long strings, trailing separators).
  if (trimmed.length > 200) return false;

  // Preserve as-is when it is safe to embed in HTML attributes / CSS selectors.
  // Allow common separators seen in the wild: ':', '-', '.', '/'.
  if (!/^[a-zA-Z0-9_:\-./]+$/.test(trimmed)) return false;

  // Avoid IDs that end with separators (often incomplete / placeholder IDs).
  if (/[:\-._/]$/.test(trimmed)) return false;

  return true;
}

function generateToolCallId(seed: string | undefined, index: number): string {
  const base = seed
    ? seed.replace(/[^a-zA-Z0-9]/g, "")
    : deterministicId(`tool_${index}_${Date.now()}`, "call").replace(/[^a-zA-Z0-9]/g, "");
  const suffix = base.slice(-12) || `${Date.now().toString(36)}${index}`;
  return `call_${suffix}`;
}
