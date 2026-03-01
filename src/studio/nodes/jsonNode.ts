import type { StudioJsonValue, StudioNodeDefinition } from "../types";
import { getText } from "./shared";

const JSON_VALUE_CONFIG_KEY = "value";

function hasKey(config: Record<string, StudioJsonValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(config, key);
}

function readConfiguredJsonValue(config: Record<string, StudioJsonValue>): StudioJsonValue {
  if (!hasKey(config, JSON_VALUE_CONFIG_KEY)) {
    return {};
  }
  const configured = config[JSON_VALUE_CONFIG_KEY];
  return typeof configured === "undefined" ? {} : configured;
}

function extractFenceBody(value: string): string | null {
  const trimmed = value.trim();
  const tripleBacktick = trimmed.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  if (tripleBacktick && tripleBacktick[1]) {
    return tripleBacktick[1];
  }
  const tripleTilde = trimmed.match(/^~~~(?:json|JSON)?\s*([\s\S]*?)\s*~~~$/);
  if (tripleTilde && tripleTilde[1]) {
    return tripleTilde[1];
  }
  return null;
}

function extractLikelyJsonBody(value: string): string | null {
  const trimmed = value.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    return trimmed.slice(firstBracket, lastBracket + 1);
  }
  return null;
}

function nextNonWhitespaceChar(value: string, startIndex: number): string | null {
  for (let index = startIndex; index < value.length; index += 1) {
    const char = value[index];
    if (!/\s/.test(char)) {
      return char;
    }
  }
  return null;
}

function repairCommonJsonFormattingIssues(value: string): string {
  const normalized = value
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'");

  let repaired = "";
  let inString = false;
  let escaped = false;
  const delimiterStack: string[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];

    if (!inString) {
      repaired += char;
      if (char === "{") {
        delimiterStack.push("{");
      } else if (char === "[") {
        delimiterStack.push("[");
      } else if (char === "}") {
        if (delimiterStack[delimiterStack.length - 1] === "{") {
          delimiterStack.pop();
        }
      } else if (char === "]") {
        if (delimiterStack[delimiterStack.length - 1] === "[") {
          delimiterStack.pop();
        }
      }
      if (char === '"') {
        inString = true;
      }
      continue;
    }

    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      repaired += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      const nextChar = nextNonWhitespaceChar(normalized, index + 1);
      const closesString =
        nextChar === null ||
        nextChar === "," ||
        nextChar === "}" ||
        nextChar === "]" ||
        nextChar === ":";
      if (closesString) {
        repaired += char;
        inString = false;
      } else {
        repaired += '\\"';
      }
      continue;
    }

    if (char === "\n") {
      repaired += "\\n";
      continue;
    }
    if (char === "\r") {
      repaired += "\\r";
      continue;
    }
    if (char === "\t") {
      repaired += "\\t";
      continue;
    }

    repaired += char;
  }

  if (inString) {
    if (escaped) {
      repaired += "\\";
    }
    repaired += '"';
  }

  repaired = repaired
    .replace(/\s+$/u, "")
    .replace(/,\s*$/u, "");

  while (delimiterStack.length > 0) {
    const opening = delimiterStack.pop();
    repaired += opening === "{" ? "}" : "]";
  }

  return repaired;
}

function parseJsonTextOrThrow(text: string): StudioJsonValue {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error(
      'JSON node received empty text input. Provide valid JSON text (for example {"key":"value"}).'
    );
  }

  const parseAttempt = (candidate: string): { ok: true; value: StudioJsonValue } | { ok: false } => {
    try {
      return {
        ok: true,
        value: JSON.parse(candidate) as StudioJsonValue,
      };
    } catch {
      return { ok: false };
    }
  };

  const candidates: string[] = [];
  const pushCandidate = (candidate: string | null): void => {
    const normalized = String(candidate || "").trim();
    if (!normalized) {
      return;
    }
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  pushCandidate(trimmed);
  pushCandidate(extractFenceBody(trimmed));
  for (const candidate of [...candidates]) {
    pushCandidate(extractLikelyJsonBody(candidate));
  }

  for (const candidate of candidates) {
    const parsed = parseAttempt(candidate);
    if (parsed.ok) {
      return parsed.value;
    }
  }

  for (const candidate of candidates) {
    const repairedCandidate = repairCommonJsonFormattingIssues(candidate);
    const parsed = parseAttempt(repairedCandidate);
    if (parsed.ok) {
      return parsed.value;
    }
  }

  try {
    return JSON.parse(trimmed) as StudioJsonValue;
  } catch (primaryError) {
    const fenceBody = extractFenceBody(trimmed);
    if (fenceBody) {
      try {
        return JSON.parse(fenceBody.trim()) as StudioJsonValue;
      } catch {
        // Fall through to canonical error.
      }
    }
    const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
    throw new Error(
      `JSON node received text input that is not valid JSON (auto-repair attempted). Fix the input JSON and rerun. (${message})`
    );
  }
}

export const jsonNode: StudioNodeDefinition = {
  kind: "studio.json",
  version: "1.0.0",
  capabilityClass: "local_cpu",
  cachePolicy: "by_inputs",
  inputPorts: [
    { id: "json", type: "json", required: false },
    { id: "text", type: "text", required: false },
  ],
  outputPorts: [{ id: "json", type: "json" }],
  configDefaults: {},
  configSchema: {
    fields: [],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const inputs = context.inputs as Record<string, StudioJsonValue>;
    const hasJsonInput = hasKey(inputs, "json");
    const hasTextInput = hasKey(inputs, "text");
    if (hasJsonInput && hasTextInput) {
      throw new Error('JSON node accepts either "json" or "text" input, not both at once.');
    }
    const config = context.node.config as Record<string, StudioJsonValue>;

    let jsonValue: StudioJsonValue;
    if (hasJsonInput) {
      jsonValue = inputs.json;
    } else if (hasTextInput) {
      const textValue = getText(inputs.text);
      jsonValue = parseJsonTextOrThrow(textValue);
    } else {
      jsonValue = readConfiguredJsonValue(config);
    }

    return {
      outputs: {
        json: jsonValue,
      },
    };
  },
};
