import { TFile, TFolder, type App, type EventRef, type TAbstractFile } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { hasHostCapability } from "../../platform/hostCapabilities";
import {
  isPathInDirectory,
  resolveKnownChatsDirectories,
} from "../chatview/ChatStorageService";
import { hasChatIdentityMetadata } from "../chatview/storage/ChatFrontmatterIdentity";
import { ChatMarkdownSerializer } from "../chatview/storage/ChatMarkdownSerializer";

export type ChatHistoryRecord = Readonly<{
  chatId: string;
  title: string;
  chatPath: string;
  lastModified: number;
  /** Null for chats saved before the count was recorded in frontmatter. */
  messageCount: number | null;
}>;

type SearchTextEntry = Readonly<{
  mtime: number;
  size: number;
  text: string;
}>;

/** Upper bound on cached search text, in characters, across all chats. */
const SEARCH_TEXT_CACHE_CHARACTERS = 8_000_000;
const SEARCH_TEXT_READ_TIMEOUT_MS = 5_000;
const DESKTOP_SEARCH_READ_CONCURRENCY = 8;
const PORTABLE_SEARCH_READ_CONCURRENCY = 1;

type HistoryHost = Pick<SystemSculptPlugin, "app" | "settings">
  & Partial<Pick<SystemSculptPlugin, "registerEvent">>;

const indexes = new WeakMap<object, ChatHistoryIndex>();

/** The plugin's shared chat history index. */
export function chatHistoryIndex(plugin: HistoryHost): ChatHistoryIndex {
  let index = indexes.get(plugin);
  if (!index) {
    index = new ChatHistoryIndex(plugin);
    indexes.set(plugin, index);
  }
  return index;
}

function messageText(content: unknown): string {
  return typeof content === "string" ? content : "";
}

async function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  const timerWindow = window.activeWindow ?? window;
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = timerWindow.setTimeout(() => resolve(fallback), SEARCH_TEXT_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) timerWindow.clearTimeout(timer);
  }
}

/**
 * Chat history from Obsidian's metadata cache and file stats: listing never
 * reads or parses a transcript. Records cover every folder a chat may still
 * live in and are rebuilt after a chat file is created, changed, renamed or
 * deleted. Full-text search reads each chat once and keeps its message text
 * until the file changes.
 */
export class ChatHistoryIndex {
  private readonly app: App;
  private readonly watching: boolean;
  private records: Readonly<{ key: string; value: readonly ChatHistoryRecord[] }> | null = null;
  private readonly searchTexts = new Map<string, SearchTextEntry>();
  private searchTextCharacters = 0;

  constructor(private readonly plugin: HistoryHost) {
    this.app = plugin.app;
    this.watching = typeof plugin.registerEvent === "function";
    if (!this.watching) return;
    const changed = (file: TAbstractFile, oldPath?: string): void => {
      this.invalidate(file.path);
      if (oldPath) this.invalidate(oldPath);
    };
    const register = (ref: EventRef): void => plugin.registerEvent!(ref);
    register(this.app.vault.on("create", (file) => changed(file)));
    register(this.app.vault.on("modify", (file) => changed(file)));
    register(this.app.vault.on("delete", (file) => changed(file)));
    register(this.app.vault.on("rename", (file, oldPath) => changed(file, oldPath)));
    register(this.app.metadataCache.on("changed", (file) => changed(file)));
  }

  public list(): readonly ChatHistoryRecord[] {
    const directories = this.directories();
    const key = directories.join("\n");
    if (this.records?.key === key) return this.records.value;
    const seen = new Set<string>();
    const records: ChatHistoryRecord[] = [];
    for (const directory of directories) {
      const folder = this.app.vault.getAbstractFileByPath(directory);
      if (!(folder instanceof TFolder)) continue;
      for (const child of folder.children) {
        if (!(child instanceof TFile) || child.extension !== "md" || seen.has(child.path)) continue;
        seen.add(child.path);
        const record = this.record(child);
        if (record) records.push(record);
      }
    }
    const value = Object.freeze(records);
    if (this.watching) this.records = { key, value };
    return value;
  }

  /**
   * The lowercased message text of one chat for full-text search. Read once
   * per file version; unreadable or corrupt chats search as empty text.
   */
  public async searchText(chatPath: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(chatPath);
    if (!(file instanceof TFile)) return "";
    const cached = this.searchTexts.get(chatPath);
    if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
      this.searchTexts.delete(chatPath);
      this.searchTexts.set(chatPath, cached);
      return cached.text;
    }
    let text = "";
    try {
      const content = await withTimeout(this.app.vault.cachedRead(file), null);
      const parsed = content === null ? null : ChatMarkdownSerializer.parseMarkdown(content);
      text = parsed
        ? parsed.messages.map((message) => messageText(message.content))
          .filter((value) => value.length > 0)
          .join("\n")
          .toLowerCase()
        : "";
    } catch {
      text = "";
    }
    this.remember(chatPath, { mtime: file.stat.mtime, size: file.stat.size, text });
    return text;
  }

  /** How many chats full-text search reads at once on this host. */
  public get searchConcurrency(): number {
    return hasHostCapability("local-filesystem")
      ? DESKTOP_SEARCH_READ_CONCURRENCY
      : PORTABLE_SEARCH_READ_CONCURRENCY;
  }

  private record(file: TFile): ChatHistoryRecord | null {
    const frontmatter: Readonly<Record<string, unknown>> | undefined =
      this.app.metadataCache.getFileCache(file)?.frontmatter;
    const chatId = frontmatter?.id;
    if (typeof chatId !== "string" || !chatId || !hasChatIdentityMetadata(frontmatter)) {
      return null;
    }
    const title = typeof frontmatter?.title === "string" ? frontmatter.title.trim() : "";
    const count = Number(frontmatter?.messageCount);
    return Object.freeze({
      chatId,
      title: title || "Untitled Chat",
      chatPath: file.path,
      lastModified: file.stat.mtime,
      messageCount: Number.isSafeInteger(count) && count >= 0 ? count : null,
    });
  }

  private directories(): string[] {
    return resolveKnownChatsDirectories(this.plugin.settings);
  }

  private invalidate(path: string): void {
    if (!this.directories().some((directory) => isPathInDirectory(path, directory))) return;
    this.records = null;
    const cached = this.searchTexts.get(path);
    if (cached) {
      this.searchTexts.delete(path);
      this.searchTextCharacters -= cached.text.length;
    }
  }

  private remember(path: string, entry: SearchTextEntry): void {
    const previous = this.searchTexts.get(path);
    if (previous) {
      this.searchTexts.delete(path);
      this.searchTextCharacters -= previous.text.length;
    }
    this.searchTexts.set(path, entry);
    this.searchTextCharacters += entry.text.length;
    for (const [oldest, value] of this.searchTexts) {
      if (this.searchTextCharacters <= SEARCH_TEXT_CACHE_CHARACTERS || oldest === path) break;
      this.searchTexts.delete(oldest);
      this.searchTextCharacters -= value.text.length;
    }
  }
}
