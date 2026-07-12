import { TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import type { ChatMessage } from "../types";
import { STUDIO_PROJECT_EXTENSION } from "../studio/types";
import { sanitizeChatTitle } from "../utils/titleUtils";

type TitleGenerationContextKind = "chat" | "note" | "studio";
const MAX_TITLE_WORDS = 8;
const MAX_TITLE_CHARS = 96;

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

function firstMeaningfulLine(value: string): string {
  const normalized = String(value || "")
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/```[\s\S]*?```/gu, " ");
  const line = normalized
    .split(/\r?\n/u)
    .map((item) => item.replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)])\s*/u, "").trim())
    .find((item) => item.length > 0 && !/^\w[\w -]*:\s*$/u.test(item));
  return line ?? "";
}

function compactTitle(value: string): string {
  const plain = firstMeaningfulLine(value)
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const words = plain.split(" ").filter(Boolean).slice(0, MAX_TITLE_WORDS);
  return sanitizeChatTitle(words.join(" ").slice(0, MAX_TITLE_CHARS)).trim();
}

export class TitleGenerationService {
  private static instance: TitleGenerationService;

  private constructor(private readonly plugin: SystemSculptPlugin) {}

  static getInstance(plugin: SystemSculptPlugin): TitleGenerationService {
    if (!TitleGenerationService.instance) TitleGenerationService.instance = new TitleGenerationService(plugin);
    return TitleGenerationService.instance;
  }

  sanitizeTitle(title: string): string {
    return sanitizeChatTitle(title);
  }

  private getContextKind(input: ChatMessage[] | TFile): TitleGenerationContextKind {
    if (!(input instanceof TFile)) return "chat";
    return input.extension.toLowerCase() === STUDIO_PROJECT_EXTENSION.slice(1) ? "studio" : "note";
  }

  private getDefaultTitle(input: ChatMessage[] | TFile): string {
    const kind = this.getContextKind(input);
    return kind === "studio" ? "Untitled Studio Project" : kind === "note" ? "Untitled Note" : "Untitled Chat";
  }

  async generateTitle(
    input: ChatMessage[] | TFile,
    onProgress?: (title: string) => void,
    onStatusUpdate?: (progress: number, status: string) => void,
    additionalContext?: string
  ): Promise<string> {
    onStatusUpdate?.(20, "Reading content…");
    let source = String(additionalContext || "").trim();
    if (!source) {
      if (input instanceof TFile) {
        source = await this.plugin.app.vault.read(input);
      } else {
        source = input.map(messageText).find((content) => content.trim().length > 0) ?? "";
      }
    }
    const title = compactTitle(source) || this.getDefaultTitle(input);
    onProgress?.(title);
    onStatusUpdate?.(100, "Title ready");
    return title;
  }
}
