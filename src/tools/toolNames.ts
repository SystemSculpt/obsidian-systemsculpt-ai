export const FIRST_PARTY_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "multi_edit",
  "create_folders",
  "list_items",
  "move",
  "trash",
  "find",
  "search",
  "open",
  "context",
] as const;

export type FirstPartyToolName = typeof FIRST_PARTY_TOOL_NAMES[number];

const FIRST_PARTY_TOOL_NAME_SET = new Set<string>(FIRST_PARTY_TOOL_NAMES);

export function normalizeFirstPartyToolName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function isFirstPartyToolName(value: unknown): value is FirstPartyToolName {
  return typeof value === "string" && FIRST_PARTY_TOOL_NAME_SET.has(value);
}
