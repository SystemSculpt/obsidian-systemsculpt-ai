import type { ChatMessage } from "../types";
import type { ToolCall } from "../types/toolCalls";
import { deterministicId } from "./id";

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
    strict?: boolean;
  };
};

export function isValidOpenAITool(tool: any): tool is OpenAITool {
  return (
    !!tool &&
    tool.type === "function" &&
    !!tool.function &&
    typeof tool.function.name === "string" &&
    tool.function.name.length > 0
  );
}

export function normalizeOpenAITools(tools: any[]): OpenAITool[] {
  const seen = new Set<string>();
  const result: OpenAITool[] = [];
  for (const tool of tools || []) {
    if (!isValidOpenAITool(tool)) continue;
    const name = tool.function.name.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    const parameters = tool.function.parameters && typeof tool.function.parameters === 'object'
      ? tool.function.parameters
      : {};
    result.push({
      type: "function",
      function: {
        name,
        description: tool.function.description || "",
        parameters,
        strict: tool.function.strict === true ? true : undefined,
      },
    });
  }
  return result;
}

export function buildOpenAIToolDefinition(input: {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  strict?: boolean;
}): OpenAITool {
  const name = String(input.name || "").trim();
  if (!name) {
    throw new Error("Tool definition missing name");
  }
  const parameters = normalizeJsonSchema(input.parameters || {});
  return {
    type: "function",
    function: {
      name,
      description: input.description || "",
      parameters,
      strict: input.strict === true ? true : undefined,
    },
  };
}

export function transformToolsForModel(modelId: string, providerEndpoint: string | undefined, tools: OpenAITool[]): any[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const isOpenRouter = typeof providerEndpoint === 'string' && providerEndpoint.includes('openrouter.ai');
  const isO4Mini = typeof modelId === 'string' && (modelId.toLowerCase().includes('o4-mini') || modelId.toLowerCase().includes('o4 mini'));

  const normalizedTools = normalizeOpenAITools(tools).map(t => ({
    type: t.type || 'function',
    function: {
      name: t.function.name,
      description: t.function.description || '',
      parameters: normalizeJsonSchema(t.function.parameters || {}),
    },
  }));

  if (isO4Mini && isOpenRouter) {
    return normalizedTools.map(t => ({
      type: t.type || 'function',
      name: t.function.name,
      description: t.function.description || '',
      parameters: t.function.parameters,
    }));
  }

  return normalizedTools;
}

export function mapAssistantToolCallsForApi(rawToolCalls: any[]): any[] {
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls
    .map((toolCall) => {
      const req: any = (toolCall && (toolCall.request || toolCall)) || {};
      const fn: any = req.function || toolCall.function || (req.name ? { name: req.name, arguments: req.arguments } : {});
      if (!fn || !fn.name) return null;
      const normalizedArgs = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      const preferredId = typeof toolCall?.id === "string" && toolCall.id.length > 0 ? toolCall.id : undefined;
      const id = preferredId ?? (typeof req.id === "string" && req.id.length > 0
        ? req.id
        : deterministicId(String(fn.name) + normalizedArgs, "call"));

      const safeTopLevel = new Set([
        "request",
        "result",
        "state",
        "messageId",
        "timestamp",
        "approvedAt",
        "executionStartedAt",
        "executionCompletedAt",
        "autoApproved",
        "serverId",
        "index",
      ]);

      const preservedTop: Record<string, unknown> = {};
      if (req && typeof req === "object") {
        for (const [key, value] of Object.entries(req)) {
          if (key === "id" || key === "type" || key === "function") continue;
          if (safeTopLevel.has(key)) continue;
          preservedTop[key] = value;
        }
      }

      const preservedFunction: Record<string, unknown> = {};
      if (fn && typeof fn === "object") {
        for (const [key, value] of Object.entries(fn)) {
          if (key === "name" || key === "arguments") continue;
          preservedFunction[key] = value;
        }
      }

      return {
        ...preservedTop,
        id,
        type: "function",
        function: {
          ...preservedFunction,
          name: String(fn.name),
          arguments: normalizedArgs,
        },
      };
    })
    .filter((tc) => tc !== null);
}

export function pruneToolMessagesNotFollowingToolCalls(messages: ChatMessage[]): { messages: ChatMessage[]; dropped: number } {
  const sanitized: ChatMessage[] = [];
  let allowedToolCallIds: Set<string> | null = null;
  let dropped = 0;

  for (const message of messages || []) {
    const role = (message as any)?.role;

    if (role === "assistant") {
      const toolCalls = Array.isArray((message as any)?.tool_calls) ? (message as any).tool_calls : [];
      const ids = toolCalls
        .map((call: any) => call?.id)
        .filter((id: any): id is string => typeof id === "string" && id.length > 0);

      allowedToolCallIds = ids.length > 0 ? new Set(ids) : null;
      sanitized.push(message);
      continue;
    }

    if (role === "tool") {
      const toolCallId = (message as any)?.tool_call_id;
      if (allowedToolCallIds && typeof toolCallId === "string" && allowedToolCallIds.has(toolCallId)) {
        sanitized.push(message);
      } else {
        dropped += 1;
      }
      continue;
    }

    allowedToolCallIds = null;
    sanitized.push(message);
  }

  return { messages: sanitized, dropped };
}

export function buildToolResultMessagesFromToolCalls(toolCalls: any[]): ChatMessage[] {
  const messages: ChatMessage[] = [] as any;
  for (const toolCall of toolCalls || []) {
    let toolContent: string;
    const state = toolCall.state;
    const result = toolCall.result;
    if (state === 'completed' && result?.success) {
      toolContent = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    } else if (state === 'failed' || (state === 'completed' && !result?.success)) {
      toolContent = JSON.stringify({ error: result?.error || { code: 'EXECUTION_FAILED', message: 'Tool execution failed without a specific error.' } });
    } else if (state === 'denied') {
      toolContent = JSON.stringify({ error: { code: 'USER_DENIED', message: 'The user has explicitly denied this tool call request.' } });
    } else {
      continue;
    }
    messages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: toolContent,
      message_id: deterministicId(toolContent, 'tool'),
    } as ChatMessage);
  }
  return messages;
}

/**
 * Normalize a JSON Schema object for provider compatibility.
 *
 * Anthropic requires input_schema to be an object schema and does not allow
 * oneOf/allOf/anyOf at the top level. This function enforces a safe shape
 * while preserving useful constraints where possible.
 */
export function normalizeJsonSchema(schema: any): Record<string, any> {
  // Fallback to permissive empty object schema
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: true } as any;
  }

  // Shallow clone to avoid mutating caller's object
  const cloned: Record<string, any> = { ...schema };

  // Ensure top-level is an object schema
  let type = cloned.type;
  if (!type || type !== 'object') {
    type = 'object';
  }

  // Preserve properties/required if present; otherwise default
  const properties = (cloned.properties && typeof cloned.properties === 'object')
    ? { ...cloned.properties }
    : {} as Record<string, any>;
  // If required is not specified, make all properties required for API compatibility
  const propertyKeys = Object.keys(properties);
  const required = Array.isArray(cloned.required)
    ? [...cloned.required]
    : (propertyKeys.length > 0 ? propertyKeys : undefined);

  // Anthropic incompatibility: remove top-level unions (keep nested ones)
  // Keep a hint by collapsing them into the object form when we can, but
  // default to permissive object if shapes differ.
  const hasTopLevelUnion = !!(cloned.oneOf || cloned.anyOf || cloned.allOf);
  let additionalProperties: any = (
    typeof cloned.additionalProperties === 'boolean' || typeof cloned.additionalProperties === 'object'
  ) ? cloned.additionalProperties : true;

  if (hasTopLevelUnion) {
    try {
      // Attempt a conservative merge of object options
      const options: any[] = (cloned.oneOf || cloned.anyOf || cloned.allOf) as any[];
      const objectOptions = (Array.isArray(options) ? options : []).filter(o => o && typeof o === 'object');

      // For allOf (intersection) we can union required and merge properties
      // For oneOf/anyOf (alternatives) we merge properties but keep required as intersection (or empty for anyOf)
      let mergedProps: Record<string, any> = { ...properties };
      let mergedRequired: string[] | undefined = required ? [...required] : undefined;

      if (objectOptions.length > 0) {
        // Collect props from each option when it's an object schema
        const requiredSets: string[][] = [];
        for (const opt of objectOptions) {
          const optType = opt.type;
          const optProps = (opt && opt.properties && typeof opt.properties === 'object') ? opt.properties : undefined;
          if (optType === 'object' && optProps) {
            mergedProps = { ...mergedProps, ...optProps };
            if (Array.isArray(opt.required)) {
              requiredSets.push(opt.required.filter((v: any) => typeof v === 'string'));
            }
            if (typeof opt.additionalProperties !== 'undefined') {
              additionalProperties = opt.additionalProperties;
            }
          }
        }

        // Compute conservative requireds
        if ((cloned as any).allOf && requiredSets.length > 0) {
          // Intersection requires union of requireds for allOf
          mergedRequired = Array.from(new Set([...(mergedRequired || []), ...requiredSets.flat()]));
        } else if (((cloned as any).oneOf || (cloned as any).anyOf) && requiredSets.length > 0) {
          // For alternatives use intersection so we don't over-constrain
          const intersect = (arrs: string[][]): string[] => arrs.reduce<string[]>((acc, cur, idx) => {
            if (idx === 0) return [...cur];
            const set = new Set(cur);
            return acc.filter(x => set.has(x));
          }, []);
          mergedRequired = intersect(requiredSets);
        }
      }

      // Replace with sanitized object schema
      const sanitized: Record<string, any> = {
        type: 'object',
        properties: mergedProps,
        ...(mergedRequired && mergedRequired.length > 0 ? { required: mergedRequired } : {}),
        ...(typeof additionalProperties !== 'undefined' ? { additionalProperties } : {}),
      };
      if (typeof cloned.description === 'string') sanitized.description = cloned.description;
      if (typeof cloned.title === 'string') sanitized.title = cloned.title;
      return sanitized;
    } catch {
      // Fall through to permissive object
      return { type: 'object', properties, ...(required ? { required } : {}), additionalProperties } as any;
    }
  }

  // No top-level union keys: keep object shape and drop illegal keys just in case
  const result: Record<string, any> = {
    type: 'object',
    properties,
    ...(required ? { required } : {}),
    ...(typeof additionalProperties !== 'undefined' ? { additionalProperties } : {}),
  } as any;
  if (typeof cloned.description === 'string') result.description = cloned.description;
  if (typeof cloned.title === 'string') result.title = cloned.title;

  return result;
}
