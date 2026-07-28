import * as obsidianApi from "obsidian";

const { parseYaml } = obsidianApi as any;

export type ChatFrontmatterEnvelope = Readonly<{
  yamlContent: string;
  body: string;
}>;

export function splitChatFrontmatter(content: string): ChatFrontmatterEnvelope | null {
  const normalizedStart = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const match = normalizedStart.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;

  return {
    yamlContent: match[1].replace(/\r\n/g, "\n"),
    body: normalizedStart.slice(match[0].length),
  };
}

export function parseChatFrontmatterYaml(yamlContent: string): Record<string, unknown> | null {
  try {
    const parsed = parseYaml(yamlContent);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function hasChatIdentityMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const metadata = value as Record<string, unknown>;
  return Boolean(metadata.id && (metadata.created || metadata.lastModified));
}

export function hasChatIdentityFrontmatter(content: string): boolean {
  const envelope = splitChatFrontmatter(content);
  if (!envelope) return false;
  return hasChatIdentityMetadata(parseChatFrontmatterYaml(envelope.yamlContent));
}
