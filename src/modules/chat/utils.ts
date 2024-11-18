import { encode } from "gpt-tokenizer";
import { TFile } from "obsidian";
import { ChatMessage } from "./ChatMessage";
import { Model } from "../../api/Model";

export const DEFAULT_CHATS_PATH = "SystemSculpt/Chats";
export const DEFAULT_SYSTEM_PROMPT =
  "You are the universe's most intelligent assistant. Your responses are succinct, problem solving, and concise. You don't limit yourself to something as unimportant as a simple AI; you're much more than that - an entity built on human history, ecompassing knowledge from all depths of what has been created thus far.";

export async function getTokenCount(
  app: any,
  chatMessages: ChatMessage[],
  contextFiles: TFile[],
  inputText: string
): Promise<number> {
  const messageHistory = chatMessages
    .map((msg) => `${msg.role}\n${msg.text}`)
    .join("\n\n");
  const contextFilesContent = await getContextFilesContent(app, contextFiles);
  const fullMessage = `${contextFilesContent}\n\n${messageHistory}\n\nuser\n${inputText}`;
  const tokens = encode(fullMessage);
  return tokens.length;
}

export async function getContextFilesContent(
  app: any,
  contextFiles: TFile[]
): Promise<string> {
  if (contextFiles.length === 0) return "";
  let contextContent = "";
  for (const file of contextFiles) {
    const fileExtension = file.extension.toLowerCase();
    if (["pdf", "docx", "pptx"].includes(fileExtension)) {
      const extractedFolder = file.parent
        ? `${file.parent.path}/${file.basename}`
        : file.basename;
      const extractedMarkdownPath =
        `${extractedFolder}/extracted_content.md`.replace(/^\/+/, "");
      const extractedMarkdownFile = app.vault.getAbstractFileByPath(
        extractedMarkdownPath
      );
      if (extractedMarkdownFile instanceof TFile) {
        const content = await app.vault.read(extractedMarkdownFile);
        contextContent += `### ${file.basename} (Extracted Content)\n${content}\n`;
      } else {
        contextContent += `### ${file.basename}\n[Content not extracted]\n`;
      }
    } else if (
      ["png", "jpg", "jpeg", "gif", "mp3", "wav", "m4a", "ogg"].includes(
        fileExtension
      )
    ) {
      contextContent += `### ${file.basename}\n[File content not included for token calculation]\n`;
    } else {
      const content = await app.vault.read(file);
      contextContent += `### ${file.basename}\n${content}\n`;
    }
  }
  return contextContent;
}

export function displayTokenCount(
  tokenCount: number,
  containerEl: HTMLElement
) {
  const tokenCountEl = containerEl.querySelector(
    ".systemsculpt-token-count"
  ) as HTMLElement;
  const titleContainerEl = containerEl.querySelector(
    ".systemsculpt-chat-title-container"
  ) as HTMLElement;

  if (tokenCountEl) {
    tokenCountEl.style.display = "inline";
    tokenCountEl.textContent = `Tokens: ${tokenCount}`;
  }

  if (titleContainerEl) titleContainerEl.style.display = "flex";
}
