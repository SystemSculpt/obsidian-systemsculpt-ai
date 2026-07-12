import type { ChatMessage } from "../../../types";
import { errorLogger } from "../../../utils/errorLogger";
import { ChatPersistenceError } from "./ChatPersistenceError";

export interface ChatPersistenceManagerOptions {
  saveChat: () => Promise<void>;
  onAssistantResponse: (message: ChatMessage) => Promise<void>;
  chatId?: () => string;
  debounceMs?: number;
}

export class ChatPersistenceManager {
  private readonly saveChat: () => Promise<void>;
  private readonly onAssistantResponse: (message: ChatMessage) => Promise<void>;
  private readonly debounceMs: number;
  private readonly chatId: () => string;
  private autosaveTimer: number | null = null;
  // Save queue semantics: ensure we never lose a final save when a prior save is in flight
  private inFlight: Promise<void> | null = null;
  private flushRequested = false;

  constructor(options: ChatPersistenceManagerOptions) {
    this.saveChat = options.saveChat;
    this.onAssistantResponse = options.onAssistantResponse;
    this.chatId = options.chatId ?? (() => "");
    this.debounceMs = options.debounceMs ?? 500;
  }

  public scheduleAutosave(): void {
    if (this.autosaveTimer) {
      window.clearTimeout(this.autosaveTimer);
    }
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      void this.requestFlush("autosave").catch(() => {
        // Autosave has no awaiting caller; the failure is logged in requestFlush.
      });
    }, this.debounceMs);
  }

  public cancelAutosave(): void {
    if (this.autosaveTimer) {
      window.clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
  }

  public async waitForIdle(): Promise<void> {
    this.cancelAutosave();
    const active = this.inFlight;
    if (active) await active;
  }

  public async commit(finalMessage: ChatMessage): Promise<void> {
    await this.waitForIdle();
    try {
      await this.onAssistantResponse(finalMessage);
    } catch (error) {
      errorLogger.error("Failed to persist assistant message", error as Error, {
        source: "ChatPersistenceManager",
        method: "commit",
        metadata: { messageId: finalMessage?.message_id },
      });
      if (error instanceof ChatPersistenceError) throw error;
      throw new ChatPersistenceError({
        operation: "assistant_commit",
        chatId: this.chatId(),
        cause: error,
      });
    }
    await this.requestFlush("commit");
  }

  // Queue-aware flush: if a save is in-flight, mark that we need another flush
  // and ensure the current run loops to perform it.
  private async requestFlush(reason: "autosave" | "commit"): Promise<void> {
    this.flushRequested = true;
    if (this.inFlight) {
      // Wait for the entire cycle (including any queued follow-ups)
      return this.inFlight;
    }

    this.inFlight = (async () => {
      try {
        while (this.flushRequested) {
          this.flushRequested = false;
          try {
            await this.saveChat();
            errorLogger.info(`Chat ${reason} completed`, {
              source: "ChatPersistenceManager",
              method: "requestFlush",
              metadata: { reason },
            });
          } catch (error) {
            errorLogger.error("Chat save failed", error as Error, {
              source: "ChatPersistenceManager",
              method: "requestFlush",
              metadata: { reason },
            });
            // On save failure, reject the entire flush cycle rather than
            // allowing a final commit to report success.
            if (error instanceof ChatPersistenceError) throw error;
            throw new ChatPersistenceError({
              operation: "flush",
              chatId: this.chatId(),
              cause: error,
            });
          }
          // Loop continues if another flush was requested while we saved
        }
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }
}
