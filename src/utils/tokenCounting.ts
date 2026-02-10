import { TokenEstimator } from "../services/embeddings/utils/TokenEstimator";
import type { ChatMessage, MultiPartContent } from "../types";

type EncodeFn = (text: string) => number[];

class LruCache<K, V> {
  private maxEntries: number;
  private map: Map<K, V>;

  constructor(maxEntries: number) {
    this.maxEntries = Math.max(50, maxEntries);
    this.map = new Map();
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // refresh LRU ordering
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      // delete oldest
      const firstKey = this.map.keys().next().value as K | undefined;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
  }
}

let attemptedTokenizerLoad = false;
let encodeImpl: EncodeFn | null = null;

function ensureTokenizerLoading(): void {
  if (attemptedTokenizerLoad) return;
  attemptedTokenizerLoad = true;
  // Try loading a tokenizer implementation in the background; fallback to heuristic if unavailable
  import("gpt-tokenizer/esm/encoding").then((mod: any) => {
    if (mod && typeof mod.encode === "function") {
      encodeImpl = (text: string) => mod.encode(text);
    }
  }).catch(() => {
    // Silently continue with heuristic estimator
  });
}

const tokenCache = new LruCache<string, number>(1000);

export function countTextTokens(text: string): number {
  if (!text) return 0;
  ensureTokenizerLoading();

  const cached = tokenCache.get(text);
  if (cached !== undefined) return cached;

  let tokens: number;
  try {
    if (encodeImpl) {
      tokens = encodeImpl(text).length;
    } else {
      // Heuristic fallback
      tokens = TokenEstimator.estimateTokens(text);
    }
  } catch {
    tokens = TokenEstimator.estimateTokens(text);
  }

  tokenCache.set(text, tokens);
  return tokens;
}

function contentToText(content: string | MultiPartContent[] | null | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let buffer = "";
    for (const part of content) {
      if ((part as any)?.type === "text") {
        buffer += (part as any).text || "";
        buffer += "\n";
      }
      // image_url parts contribute no prompt tokens in most providers; ignore
    }
    return buffer.trim();
  }
  return "";
}

export function countMessageTokens(message: ChatMessage | any): number {
  if (!message) return 0;
  let total = 0;

  // Role adds a tiny overhead; approximate +3
  total += 3;

  // Content
  if ("content" in message) {
    total += countTextTokens(contentToText((message as any).content));
  }

  // Tool calls (OpenAI-style)
  if (Array.isArray((message as any).tool_calls)) {
    try {
      const serialized = JSON.stringify((message as any).tool_calls);
      total += countTextTokens(serialized);
    } catch {
      // best-effort fallback
      total += 0;
    }
  }

  // Tool message payloads (Anthropic tool_result or OpenAI tool role)
  if ((message as any).role === "tool" && typeof (message as any).content === "string") {
    total += countTextTokens((message as any).content);
  }

  return total;
}

export function countMessagesTokens(messages: Array<ChatMessage | any>): number {
  if (!messages || messages.length === 0) return 0;
  let total = 0;
  for (const m of messages) total += countMessageTokens(m);
  // Add small overhead per message for JSON framing
  total += Math.max(0, messages.length - 1) * 2;
  return total;
}

export function countRequestTokens(body: any): number {
  if (!body || typeof body !== "object") return 0;
  let total = 0;

  if (typeof body.system === "string") {
    total += countTextTokens(body.system);
  }

  if (Array.isArray(body.messages)) {
    total += countMessagesTokens(body.messages);
  }

  // Include tool schemas lightly when present
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    try {
      const brief = JSON.stringify(body.tools.slice(0, 10));
      total += Math.min(countTextTokens(brief), 2000);
    } catch {}
  }

  // Include web_search_options/plugins minimally
  if (body.web_search_options) {
    try { total += countTextTokens(JSON.stringify(body.web_search_options)); } catch {}
  }
  if (Array.isArray(body.plugins) && body.plugins.length > 0) {
    try { total += countTextTokens(JSON.stringify(body.plugins)); } catch {}
  }

  return total;
}

// ───────────────────────── Embeddings-compatible helpers ─────────────────────────
const HEURISTIC_CHARS_PER_TOKEN = 4;
const MAX_TOKENS_PER_REQUEST = 8191;
const SAFETY_MARGIN = 0.9;
const MAX_BATCH_SIZE = 25;

export function estimateTokens(text: string): number {
  return countTextTokens(text);
}

export function calculateOptimalBatchSize(texts: string[]): number {
  if (!texts || texts.length === 0) return 0;
  const tokenCounts = texts.map(t => estimateTokens(t)).sort((a, b) => b - a);
  const maxTokensAllowed = MAX_TOKENS_PER_REQUEST * SAFETY_MARGIN;
  let batchSize = 0;
  let total = 0;
  for (const n of tokenCounts) {
    if (total + n <= maxTokensAllowed && batchSize < MAX_BATCH_SIZE) {
      total += n;
      batchSize++;
    } else {
      break;
    }
  }
  return Math.max(1, batchSize);
}

export function createOptimizedBatches<T extends { content: string }>(items: T[]): T[][] {
  if (!items || items.length === 0) return [];
  const batches: T[][] = [];
  let current: T[] = [];
  let currentTokens = 0;
  const maxTokensAllowed = MAX_TOKENS_PER_REQUEST * SAFETY_MARGIN;
  const sorted = [...items].sort((a, b) => a.content.length - b.content.length);
  for (const item of sorted) {
    const itemTokens = estimateTokens(item.content);
    if (itemTokens > maxTokensAllowed) {
      if (current.length > 0) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      batches.push([item]);
      continue;
    }
    if (currentTokens + itemTokens > maxTokensAllowed || current.length >= MAX_BATCH_SIZE) {
      batches.push(current);
      current = [item];
      currentTokens = itemTokens;
    } else {
      current.push(item);
      currentTokens += itemTokens;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function truncateToTokenLimit(text: string, maxTokens?: number): string {
  const limit = maxTokens || (MAX_TOKENS_PER_REQUEST * SAFETY_MARGIN);
  const est = estimateTokens(text);
  if (est <= limit) return text;
  const charLimit = Math.floor(limit * HEURISTIC_CHARS_PER_TOKEN * 0.9);
  return text.substring(0, Math.max(0, charLimit)) + "...";
}

export function getBatchStatistics(texts: string[]): {
  totalTexts: number;
  totalEstimatedTokens: number;
  averageTokensPerText: number;
  maxTokensInSingleText: number;
  recommendedBatchSize: number;
  estimatedBatches: number;
} {
  if (!texts || texts.length === 0) {
    return {
      totalTexts: 0,
      totalEstimatedTokens: 0,
      averageTokensPerText: 0,
      maxTokensInSingleText: 0,
      recommendedBatchSize: 0,
      estimatedBatches: 0,
    };
  }
  const counts = texts.map(t => estimateTokens(t));
  const total = counts.reduce((s, n) => s + n, 0);
  const max = Math.max(...counts);
  const avg = total / texts.length;
  const recommended = calculateOptimalBatchSize(texts);
  const batches = Math.ceil(texts.length / (recommended || 1));
  return {
    totalTexts: texts.length,
    totalEstimatedTokens: total,
    averageTokensPerText: Math.round(avg),
    maxTokensInSingleText: max,
    recommendedBatchSize: recommended,
    estimatedBatches: batches,
  };
}

export function countToolCallArgumentsTokens(toolCall: any): number {
  try {
    const fn = toolCall?.request?.function || toolCall?.function || toolCall?.request?.tool?.function;
    if (!fn) return 0;
    const rawArgs = fn.arguments;
    if (typeof rawArgs === "string") return countTextTokens(rawArgs);
    if (rawArgs && typeof rawArgs === "object") return countTextTokens(JSON.stringify(rawArgs));
    return 0;
  } catch {
    return 0;
  }
}

export function countToolCallPayloadTokens(toolCall: any): number {
  try {
    const fn = toolCall?.request?.function || toolCall?.function || toolCall?.request?.tool?.function;
    const name = String(fn?.name || "");
    let argsStr = "";
    const ra = fn?.arguments;
    argsStr = typeof ra === "string" ? ra : JSON.stringify(ra ?? {});
    const normalized: any = {
      type: "function",
      function: { name, arguments: argsStr }
    };
    if (toolCall?.id) normalized.id = toolCall.id;
    return countTextTokens(JSON.stringify(normalized));
  } catch {
    return 0;
  }
}

export function countToolResultTokens(toolCall: any): number {
  try {
    // Match exactly what ContextFileService.prepareMessagesWithContext sends
    // as the tool message content for this tool call
    const state: string = String(toolCall?.state || '').toLowerCase();
    const result = toolCall?.result;

    let contentToSend: string | null = null;

    if (state === 'completed' && result?.success) {
      const data = result?.data;
      contentToSend = typeof data === 'string' ? data : JSON.stringify(data ?? null);
    } else if (state === 'failed' || (state === 'completed' && !result?.success)) {
      const errorObj = result?.error || { code: 'EXECUTION_FAILED', message: 'Tool execution failed without a specific error.' };
      contentToSend = JSON.stringify({ error: errorObj });
    } else {
      // Non-terminal or unknown state contributes nothing yet
      return 0;
    }

    if (!contentToSend) return 0;
    return countTextTokens(contentToSend);
  } catch {
    return 0;
  }
}

export function countToolCallTokensForProvider(toolCall: any, providerKind: 'openai' | 'anthropic' | 'native' | string = 'openai'): number {
  try {
    const fn = toolCall?.request?.function || toolCall?.function || toolCall?.request?.tool?.function;
    const name = String(fn?.name || "");
    const id = toolCall?.id || "";

    if ((providerKind as string).toLowerCase().includes('anthropic')) {
      // Anthropic tool_use block: arguments as parsed object
      let input: any = {};
      try {
        const raw = fn?.arguments;
        if (typeof raw === 'string') {
          try { input = JSON.parse(raw); } catch { input = {}; }
        } else if (raw && typeof raw === 'object') {
          input = raw;
        }
      } catch { input = {}; }
      const toolUse = { type: 'tool_use', id, name, input };
      return countTextTokens(JSON.stringify(toolUse));
    }

    // Default/OpenAI/native: function call with JSON-string arguments
    let argsStr = '';
    const ra = fn?.arguments;
    argsStr = typeof ra === 'string' ? ra : JSON.stringify(ra ?? {});
    const openAiShape: any = { type: 'function', function: { name, arguments: argsStr } };
    if (id) openAiShape.id = id;
    return countTextTokens(JSON.stringify(openAiShape));
  } catch {
    return 0;
  }
}
