import { TFile } from 'obsidian';
import type { ChatMessage, MultiPartContent, MessagePart } from '../../../types';
import type { ToolCall } from '../../../types/toolCalls';
import { SystemPromptService } from '../../../services/SystemPromptService';
import { getModelLabelWithProvider } from '../../../utils/modelUtils';
import { errorLogger } from '../../../utils/errorLogger';
import type { ChatView } from '../ChatView';
import { MessagePartNormalizer } from '../utils/MessagePartNormalizer';
import { ChatExportBuilder } from './ChatExportBuilder';
import type { ChatExportContext, ChatExportResult, ChatExportSummary } from './ChatExportTypes';
import { normalizeChatExportOptions, ChatExportOptions } from '../../../types/chatExport';

export class ChatExportService {
  private readonly chatView: ChatView;

  constructor(chatView: ChatView) {
    this.chatView = chatView;
  }

  public async export(overrides?: Partial<ChatExportOptions>): Promise<ChatExportResult> {
    const options = normalizeChatExportOptions(overrides);
    errorLogger.info('Preparing chat export', {
      source: 'ChatExportService',
      method: 'export',
      metadata: {
        chatId: this.chatView.chatId,
        messageCount: this.chatView.messages.length,
        options,
      },
    });

    const context = await this.buildContext(options);
    const builder = new ChatExportBuilder(context);
    const markdown = builder.build(options);

    errorLogger.info('Chat export complete', {
      source: 'ChatExportService',
      method: 'export',
      metadata: {
        chatId: context.chatId,
        includedMessages: context.summary.totalMessages,
        toolCalls: context.summary.toolCallCount,
      },
    });

    return {
      markdown,
      context,
      options,
    };
  }

  private async buildContext(options: ChatExportOptions): Promise<ChatExportContext> {
    const exportedAt = new Date();

    const modelLabel = this.chatView.selectedModelId
      ? getModelLabelWithProvider(this.chatView.selectedModelId)
      : (this.chatView.currentModelName || '');

    const systemPrompt = options.includeSystemPrompt
      ? await this.resolveSystemPrompt()
      : undefined;

    const contextFiles = options.includeContextFiles
      ? await this.collectContextFiles(options)
      : [];

    const summary = this.calculateSummary(this.chatView.messages);

    return {
      title: this.chatView.chatTitle,
      chatId: this.chatView.chatId,
      chatVersion: this.chatView.chatVersion,
      exportedAt,
      model: modelLabel ? { id: this.chatView.selectedModelId, label: modelLabel } : undefined,
      systemPrompt,
      contextFiles,
      messages: [...this.chatView.messages],
      summary,
    };
  }

  private calculateSummary(messages: ChatMessage[]): ChatExportSummary {
    const summary: ChatExportSummary = {
      totalMessages: messages.length,
      assistantMessages: 0,
      userMessages: 0,
      toolMessages: 0,
      toolCallCount: 0,
      reasoningBlockCount: 0,
      imageCount: 0,
    };

    for (const message of messages) {
      switch (message.role) {
        case 'assistant':
          summary.assistantMessages += 1;
          break;
        case 'user':
          summary.userMessages += 1;
          break;
        case 'tool':
          summary.toolMessages += 1;
          break;
        default:
          break;
      }

      const parts = MessagePartNormalizer.toParts(message);
      parts.forEach((part: MessagePart) => {
        if (part.type === 'tool_call') {
          summary.toolCallCount += 1;
        }
        if (part.type === 'reasoning') {
          summary.reasoningBlockCount += 1;
        }
        if (part.type === 'content') {
          summary.imageCount += this.countImages(part.data as string | MultiPartContent[] | null);
        }
      });

      if (!parts.length && message.content) {
        summary.imageCount += this.countImages(message.content);
      }
    }

    return summary;
  }

  private countImages(content: string | MultiPartContent[] | null): number {
    if (!content || typeof content === 'string') {
      return 0;
    }
    let count = 0;
    content.forEach((part) => {
      if (part.type === 'image_url' && part.image_url?.url) {
        count += 1;
      }
    });
    return count;
  }

  private async resolveSystemPrompt() {
    try {
      const type = this.chatView.systemPromptType || 'general-use';
      const path = this.chatView.systemPromptPath;
      const service = SystemPromptService.getInstance(this.chatView.app, () => this.chatView.plugin.settings);
      const basePrompt = await service.getSystemPromptContent(type as any, path, this.chatView.agentMode);
      const combined = await service.combineWithAgentPrefix(basePrompt, type, this.chatView.agentMode);

      return {
        type,
        label: this.deriveSystemPromptLabel(type, path),
        content: combined,
      };
    } catch (error) {
      errorLogger.warn('Failed to resolve system prompt for export', {
        source: 'ChatExportService',
        method: 'resolveSystemPrompt',
        metadata: {
          chatId: this.chatView.chatId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return undefined;
    }
  }

  private deriveSystemPromptLabel(type: string, path?: string): string {
    const normalized = (type || '').toLowerCase();
    if (normalized === 'custom' && path) {
      const segments = path.split('/');
      return segments[segments.length - 1] || 'Custom';
    }
    if (normalized === 'general-use') {
      return 'General Use';
    }
    if (normalized === 'concise') {
      return 'Concise';
    }
    if (normalized === 'agent') {
      return 'Agent';
    }
    return this.capitalize(type || 'System Prompt');
  }

  private async collectContextFiles(options: ChatExportOptions) {
    const results: { path: string; content?: string }[] = [];
    const contextManager = this.chatView.contextManager;
    if (!contextManager) {
      return results;
    }

    const seen = new Set<string>();
    const rawFiles = Array.from(contextManager.getContextFiles?.() || []);

    for (const entry of rawFiles) {
      const cleanPath = this.cleanContextFileEntry(entry);
      if (!cleanPath || seen.has(cleanPath)) {
        continue;
      }
      seen.add(cleanPath);

      const record: { path: string; content?: string } = { path: cleanPath };

      if (options.includeContextFileContents) {
        const content = await this.tryReadFileContents(cleanPath);
        if (content) {
          record.content = content;
        }
      }

      results.push(record);
    }

    return results;
  }

  private cleanContextFileEntry(entry: string): string | null {
    if (!entry) {
      return null;
    }
    if (entry.startsWith('doc:')) {
      return null;
    }
    const withoutWiki = entry.replace(/^\[\[(.*?)\]\]$/, '$1');
    const withoutMath = withoutWiki.replace(/\$begin:math:display\$\[(.*?)\$end:math:display\$]/g, '$1');
    const trimmed = withoutMath.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async tryReadFileContents(path: string): Promise<string | undefined> {
    try {
      const file = this.chatView.app.metadataCache.getFirstLinkpathDest(path, '');
      if (!(file instanceof TFile)) {
        return undefined;
      }
      if (this.isBinaryFile(file)) {
        return undefined;
      }
      return await this.chatView.app.vault.read(file);
    } catch (error) {
      errorLogger.warn('Failed to read context file for export', {
        source: 'ChatExportService',
        method: 'tryReadFileContents',
        metadata: {
          path,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return undefined;
    }
  }

  private isBinaryFile(file: TFile): boolean {
    const extension = file.extension?.toLowerCase();
    return /^(png|jpe?g|webp|bmp|svg|mp3|wav|flac|ogg|mp4|m4a|mov|pdf|zip|tar|gz)$/i.test(extension);
  }

  private capitalize(value: string): string {
    if (!value) {
      return '';
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
}
