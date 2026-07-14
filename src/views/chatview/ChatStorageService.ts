import { App, TFile, stringifyYaml } from "obsidian";
import { ChatMessage } from "../../types";
import {
  ChatAttachmentVaultStore,
  collectChatAttachmentRefKeys,
  isChatAttachmentContentRef,
} from "./attachments/ChatAttachmentVaultStore";
import { ChatMarkdownSerializer } from "./storage/ChatMarkdownSerializer";
import type {
  ChatApprovalMode,
  ChatMetadata,
  ChatResumeDescriptor,
  ManagedChatSessionBinding,
} from "./storage/ChatPersistenceTypes";
import { parseManagedChatSessionBinding } from "./storage/ChatPersistenceTypes";

type LoadedChatRecord = {
  id: string;
  messages: ChatMessage[];
  lastModified: number;
  title: string;
  version?: number;
  context_files?: string[];
  chatFontSize?: "small" | "medium" | "large";
  approvalMode?: ChatApprovalMode;
  managedSession?: ManagedChatSessionBinding;
  chatPath: string;
};

type SaveChatOptions = {
  contextFiles?: Set<string>;
  title?: string;
  chatFontSize?: "small" | "medium" | "large";
  approvalMode?: ChatApprovalMode;
  managedSession?: ManagedChatSessionBinding;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeAttachmentMetadata(value: string): unknown {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

/**
 * Parse the raw ref attributes independently from the forgiving chat reader.
 * The normal reader is allowed to skip malformed historical messages; GC is
 * not, because a skipped descriptor could be the only remaining CAS owner.
 */
function collectRawAttachmentRefKeys(content: string): ReadonlySet<string> | null {
  const declaredMessageCount = content.match(/<!-- SYSTEMSCULPT-MESSAGE-START /g)?.length ?? 0;
  const messageStarts = content.matchAll(/<!-- SYSTEMSCULPT-MESSAGE-START ([^\r\n]*?) -->/g);
  const references = new Set<string>();
  let parsedMessageCount = 0;

  try {
    for (const start of messageStarts) {
      parsedMessageCount += 1;
      const attributes = start[1];
      if (!attributes.includes("attachment-metadata")) continue;
      const matches = [...attributes.matchAll(
        /(?:^|\s)attachment-metadata="([A-Za-z0-9+/=]+)"(?=\s|$)/g,
      )];
      if (matches.length !== 1) return null;
      const decoded = decodeAttachmentMetadata(matches[0][1]);
      if (!Array.isArray(decoded) || decoded.length === 0) return null;
      const positions = new Set<number>();
      for (const value of decoded) {
        if (!isRecord(value)
          || !Object.keys(value).every((key) => [
            "id", "name", "mimeType", "byteLength", "kind", "contentPartIndex", "contentRef",
          ].includes(key))
          || typeof value.id !== "string" || !value.id.trim()
          || typeof value.name !== "string" || !value.name.trim()
          || typeof value.mimeType !== "string" || !value.mimeType.trim()
          || !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0
          || !Number.isSafeInteger(value.contentPartIndex) || (value.contentPartIndex as number) < 0
          || !["document", "image", "text"].includes(String(value.kind))) return null;
        const position = value.contentPartIndex as number;
        if (positions.has(position)) return null;
        positions.add(position);
        if (typeof value.contentRef === "undefined") continue;
        if (!isChatAttachmentContentRef(value.contentRef)) return null;
        if (value.kind === "image"
          ? value.contentRef.payload !== "image-bytes"
          : value.contentRef.payload !== "utf8-content-part") return null;
        references.add(`${value.contentRef.payload}:${value.contentRef.sha256}`);
      }
    }
  } catch {
    return null;
  }

  return parsedMessageCount === declaredMessageCount ? references : null;
}

export class ChatStorageService {
  private app: App;
  private chatDirectory: string;
  private readonly attachmentStore: ChatAttachmentVaultStore | null;

  constructor(app: App, chatDirectory: string) {
    this.app = app;
    this.chatDirectory = chatDirectory;
    const adapter = (app as any)?.vault?.adapter;
    this.attachmentStore = adapter ? new ChatAttachmentVaultStore(adapter) : null;
  }

  private normalizeTag(tag: string): string {
    return tag.trim().replace(/^#+/, "");
  }

  private resolveDefaultChatTag(): string {
    const systemSculptPlugin = (this.app as any)?.plugins?.plugins?.["systemsculpt-ai"];
    const rawTag = systemSculptPlugin?.settings?.defaultChatTag;
    if (typeof rawTag !== "string") return "";
    return this.normalizeTag(rawTag);
  }

  private mergeTags(existingTags: string[], defaultTag: string): string[] {
    const merged = [...existingTags];
    if (defaultTag) merged.push(defaultTag);
    return Array.from(new Set(merged));
  }

  // Master save method - always saves in the new, simple format
  async saveChat(
    chatId: string,
    messages: ChatMessage[],
    options: SaveChatOptions = {},
  ): Promise<{ version: number }> {
    try {
      const { version } = await this.saveChatSimple(
        chatId,
        messages,
        options,
      );
      return { version };
    } catch (error) {
      const detail = error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "Unknown Obsidian vault error";
      const wrapped = new Error(`Failed to save chat to ${chatId}.md: ${detail}`) as Error & { cause?: unknown };
      wrapped.cause = error;
      throw wrapped;
    }
  }
  
  async createChatExclusive(
    chatId: string,
    messages: ChatMessage[],
    options: SaveChatOptions = {},
  ): Promise<{ version: number } | null> {
    const filePath = `${this.chatDirectory}/${chatId}.md`;
    try {
      const result = await this.saveChatSimple(chatId, messages, options, true);
      return { version: result.version };
    } catch (error) {
      // Obsidian's vault.create is exclusive. A path that exists after the
      // failed create means another writer won the race; callers should try
      // the next deterministic suffix. Other failures remain fatal.
      if (await this.app.vault.adapter.exists(filePath)) {
        return null;
      }
      throw error;
    }
  }

  private async saveChatSimple(
    chatId: string,
    messages: ChatMessage[],
    options: SaveChatOptions = {},
    exclusiveCreate: boolean = false,
  ): Promise<{ filePath: string; version: number }> {
    let filePath = `[unknown-path]/${chatId}.md`;
    try {
      filePath = `${this.chatDirectory}/${chatId}.md`;
      const now = new Date().toISOString();
      const vault = this.app.vault;
      let fileExists = false;
      let existingMetadata: ChatMetadata | null = null;

      const file = exclusiveCreate ? null : vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        fileExists = true;
        const content = await vault.read(file);
        existingMetadata = ChatMarkdownSerializer.parseMetadata(content);
      }

      const creationDate = existingMetadata?.created || now;
      const existingTags = existingMetadata?.tags ?? [];
      const defaultChatTag = this.resolveDefaultChatTag();
      const mergedTags = this.mergeTags(existingTags, defaultChatTag);
      // CRITICAL: Only increment version if we're actually changing content
      // If messages are empty and file exists with content, preserve the version
      const currentVersion = Number(existingMetadata?.version) || 0;
      let newVersion = currentVersion + 1;
      
      // Safety check: Don't overwrite an existing local chat with an empty transcript.
      if (messages.length === 0 && fileExists && existingMetadata && file instanceof TFile) {
        // Check if the existing file has messages (simple heuristic: check for message markers)
        const existingContent = await vault.read(file);
        if (existingContent.includes('SYSTEMSCULPT-MESSAGE-START')) {
          throw new Error('Cannot save empty messages over existing chat content');
        }
      }

      const metadata: ChatMetadata = {
        id: chatId,
        created: creationDate,
        lastModified: now,
        title: options.title || existingMetadata?.title || "Untitled Chat",
        version: newVersion,
        chatFontSize: options.chatFontSize || "medium",
        approvalMode: options.approvalMode === "full-access" ? "full-access" : "ask",
      };
      if (options.managedSession?.boundChatId === chatId) {
        metadata.managedSession = options.managedSession;
      }

      if (mergedTags.length > 0) {
        metadata.tags = mergedTags;
      }

      if (options.contextFiles && options.contextFiles.size > 0) {
        metadata.context_files = Array.from(options.contextFiles).map((path) => ({
          path,
          type: path.includes("/Extractions/") ? "extraction" : "source",
        }));
      }

      const messagesContent = ChatMarkdownSerializer.serializeMessages(
        messages.map((message) => {
          if (collectChatAttachmentRefKeys([message]).size === 0) return message;
          if (!this.attachmentStore) {
            throw new Error("Attachment references cannot be saved without a vault adapter.");
          }
          return this.attachmentStore.materializeMessageReferences(message);
        }),
      );

      const fullContent = `---\n${stringifyYaml(metadata)}---\n\n${messagesContent}`;

      const SystemSculptPlugin = (this.app as any).plugins.plugins["systemsculpt-ai"];

      if (SystemSculptPlugin && SystemSculptPlugin.directoryManager) {
        await SystemSculptPlugin.directoryManager.ensureDirectoryByPath(this.chatDirectory);
      } else {
        const exists = await this.app.vault.adapter.exists(this.chatDirectory);
        if (!exists) {
          await this.app.vault.createFolder(this.chatDirectory);
        }
      }

      if (!exclusiveCreate && fileExists && file instanceof TFile) {
        await vault.modify(file, fullContent);
      } else {
        await vault.create(filePath, fullContent);
      }
      
      return { filePath, version: newVersion };
    } catch (error) {
      throw error;
    }
  }

  async loadChats(): Promise<LoadedChatRecord[]> {
    try {
      const files = await this.app.vault.adapter.list(this.chatDirectory);
      const chatFiles = files.files.filter((f) => f.endsWith(".md"));

      const chats = await Promise.allSettled(
        chatFiles.map(async (filePath) => {
          try {
            // NEW: Try to read file stats first to get a reliable last modified timestamp
            let fileModifiedTime: number | null = null;
            const abstractFile = this.app.vault.getAbstractFileByPath(filePath);
            if (abstractFile instanceof TFile) {
              fileModifiedTime = abstractFile.stat.mtime;
            }

            const content = await this.app.vault.adapter.read(filePath);
            
            // Validate file structure before attempting to parse
            if (!this.isValidChatFile(content)) {
              // Silently skip files that are not valid chat files (e.g., empty files, other markdown notes).
              // A warning will be logged by the parser later if a file appears to be a chat file but is corrupted.
              return null;
            }
            
            const parsed = this.parseMarkdownContent(content, filePath);

            if (!parsed) return null;

            // If we managed to read a reliable mtime from the file, prefer that over whatever the parser returned.
            if (fileModifiedTime && !isNaN(fileModifiedTime)) {
              parsed.lastModified = fileModifiedTime;
            }

            return parsed;
          } catch (error) {
            return null;
          }
        })
      );

      // Extract successful results and filter out nulls
      const successfulChats = chats
        .filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
        .map(result => result.value)
        .filter((chat): chat is NonNullable<typeof chat> => chat !== null);

      // Log any failures for debugging
      const failedCount = chats.length - successfulChats.length;
      if (failedCount > 0) {
      }

      return successfulChats;
    } catch (error) {
      return [];
    }
  }

  /**
   * Builds the durable chat side of the attachment reachability graph. A
   * malformed ref-bearing chat fails closed so garbage collection cannot
   * delete a payload that might still be recoverable from that file.
   */
  public async collectAttachmentRefKeys(): Promise<ReadonlySet<string> | null> {
    const adapter = this.app.vault.adapter;
    try {
      if (!await adapter.exists(this.chatDirectory)) return new Set();
      const directories = [this.chatDirectory];
      const chatFiles: string[] = [];
      while (directories.length > 0) {
        const directory = directories.pop()!;
        const entries = await adapter.list(directory);
        chatFiles.push(...entries.files.filter((path) => path.endsWith(".md")));
        directories.push(...entries.folders);
      }

      const references = new Set<string>();
      for (const filePath of chatFiles) {
        const content = await adapter.read(filePath);
        if (!content.includes("<!-- SYSTEMSCULPT-MESSAGE-START ")) continue;
        const parsed = ChatMarkdownSerializer.parseMarkdown(content);
        const rawReferences = collectRawAttachmentRefKeys(content);
        if (!parsed || !rawReferences) return null;
        const parsedReferences = collectChatAttachmentRefKeys(parsed.messages);
        if (parsedReferences.size !== rawReferences.size
          || [...parsedReferences].some((key) => !rawReferences.has(key))) return null;
        for (const key of rawReferences) references.add(key);
      }
      return references;
    } catch {
      return null;
    }
  }

  async loadChat(chatId: string): Promise<LoadedChatRecord | null> {
    try {
      const filePath = `${this.chatDirectory}/${chatId}.md`;
      const file = this.app.vault.getAbstractFileByPath(filePath);

      if (!(file instanceof TFile)) {
        return null;
      }

      const content = await this.app.vault.read(file);
      const parsed = this.parseMarkdownContent(content, filePath);
      if (!parsed) return null;
      this.attachmentStore?.claimMessageReferences(parsed.messages);
      return {
        ...parsed,
        // Keep CAS-backed attachment payloads lazy. The chat surface can render
        // compact metadata immediately, while request preparation resolves the
        // bytes only if the user actually continues or retries this chat.
        messages: parsed.messages,
      };
    } catch (error) {
      return null;
    }
  }

  private parseMarkdownContent(content: string, filePath?: string): LoadedChatRecord | null {
    // NEW: Delegate modern parsing logic to central serializer
    const parsed = ChatMarkdownSerializer.parseMarkdown(content);
    if (parsed) {
      const { metadata, messages } = parsed;
      return this.finalizeParsedData(metadata, messages, filePath);
    }

    return null;
  }

  private finalizeParsedData(metadata: ChatMetadata, messages: ChatMessage[], filePath?: string): LoadedChatRecord {
    return {
      id: metadata.id,
      messages,
      lastModified: new Date(metadata.lastModified).getTime(),
      title: metadata.title,
      version: metadata.version || 0,
      context_files: metadata.context_files?.map((f) => f.path) || [],
      chatFontSize: metadata.chatFontSize,
      approvalMode: metadata.approvalMode === "full-access" ? "full-access" : "ask",
      managedSession: parseManagedChatSessionBinding(metadata.managedSession, metadata.id),
      chatPath: filePath || `${this.chatDirectory}/${metadata.id}.md`,
    };
  }

  public async getChatResumeDescriptor(chatId: string): Promise<ChatResumeDescriptor | null> {
    const record = await this.loadChat(chatId);
    if (!record) {
      return null;
    }

    return {
      chatId: record.id,
      title: record.title,
      chatPath: record.chatPath,
      lastModified: record.lastModified,
      messageCount: record.messages.length,
    };
  }

  /**
   * Validates that a file has the expected chat file structure
   */
  private isValidChatFile(content: string): boolean {
    // Check for modern format with frontmatter
    const hasFrontmatter = /^---\n[\s\S]*?\n---/.test(content);
    
    // Check for SystemSculpt message markers (current format)
    const hasMessageMarkers = content.includes('SYSTEMSCULPT-MESSAGE-START') && 
                              content.includes('SYSTEMSCULPT-MESSAGE-END');

    return hasFrontmatter || hasMessageMarkers;
  }

}
