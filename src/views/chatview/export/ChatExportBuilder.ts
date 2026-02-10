import { ChatExportContext } from './ChatExportTypes';
import { ChatExportOptions } from '../../../types/chatExport';
import { MessagePartNormalizer } from '../utils/MessagePartNormalizer';
import type { MessagePart, MultiPartContent } from '../../../types';
import type { ToolCall } from '../../../types/toolCalls';

const OPTION_KEYS: Array<keyof ChatExportOptions> = [
  'includeMetadata',
  'includeSystemPrompt',
  'includeContextFiles',
  'includeContextFileContents',
  'includeConversation',
  'includeUserMessages',
  'includeAssistantMessages',
  'includeToolMessages',
  'includeReasoning',
  'includeToolCalls',
  'includeToolCallArguments',
  'includeToolCallResults',
  'includeImages',
];

export class ChatExportBuilder {
  constructor(private readonly context: ChatExportContext) {}

  public build(options: ChatExportOptions): string {
    const sections: string[] = [];

    sections.push(this.renderFrontMatter(options));

    if (options.includeMetadata) {
      const summary = this.renderSummary();
      if (summary) sections.push(summary);
    }

    if (options.includeSystemPrompt) {
      const prompt = this.renderSystemPrompt();
      if (prompt) sections.push(prompt);
    }

    if (options.includeContextFiles) {
      const contextFiles = this.renderContextFiles(options);
      if (contextFiles) sections.push(contextFiles);
    }

    if (options.includeConversation) {
      const conversation = this.renderConversation(options);
      if (conversation) sections.push(conversation);
    }

    return sections.filter(Boolean).join('\n\n') + '\n';
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Front matter
  // ────────────────────────────────────────────────────────────────────────────

  private renderFrontMatter(options: ChatExportOptions): string {
    const lines: string[] = ['---'];
    lines.push(`title: "${this.escapeYaml(this.context.title || 'Chat Export')}"`);

    if (this.context.chatId) {
      lines.push(`chatId: "${this.escapeYaml(this.context.chatId)}"`);
    }

    if (typeof this.context.chatVersion === 'number') {
      lines.push(`chatVersion: ${this.context.chatVersion}`);
    }

    const exportedAt = this.context.exportedAt instanceof Date
      ? this.context.exportedAt.toISOString()
      : String(this.context.exportedAt || new Date().toISOString());
    lines.push(`exportedAt: "${this.escapeYaml(exportedAt)}"`);

    if (this.context.model?.id || this.context.model?.label) {
      lines.push('model:');
      if (this.context.model.id) {
        lines.push(`  id: "${this.escapeYaml(this.context.model.id)}"`);
      }
      if (this.context.model.label) {
        lines.push(`  label: "${this.escapeYaml(this.context.model.label)}"`);
      }
    }

    lines.push('options:');
    OPTION_KEYS.forEach((key) => {
      lines.push(`  ${key}: ${options[key]}`);
    });

    lines.push('---');
    return lines.join('\n');
  }

  private escapeYaml(value: string): string {
    return value.replace(/"/g, '\\"');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────────────────────────────────

  private renderSummary(): string | null {
    const summary = this.context.summary;
    const lines: string[] = ['## Summary'];

    if (!summary) {
      lines.push('', '_No summary available._');
      return lines.join('\n');
    }

    const bulletLines: string[] = [];
    if (summary.totalMessages > 0) {
      bulletLines.push(`- Total messages: ${summary.totalMessages}`);
    }
    if (summary.assistantMessages > 0) {
      bulletLines.push(`- Assistant messages: ${summary.assistantMessages}`);
    }
    if (summary.userMessages > 0) {
      bulletLines.push(`- User messages: ${summary.userMessages}`);
    }
    if (summary.toolMessages > 0) {
      bulletLines.push(`- Tool messages: ${summary.toolMessages}`);
    }
    if (summary.toolCallCount > 0) {
      bulletLines.push(`- Tool calls: ${summary.toolCallCount}`);
    }
    if (summary.reasoningBlockCount > 0) {
      bulletLines.push(`- Reasoning blocks: ${summary.reasoningBlockCount}`);
    }
    if (summary.imageCount > 0) {
      bulletLines.push(`- Images referenced: ${summary.imageCount}`);
    }

    lines.push('');
    if (bulletLines.length === 0) {
      lines.push('_No message statistics available._');
    } else {
      lines.push(...bulletLines);
    }
    return lines.join('\n');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // System prompt
  // ────────────────────────────────────────────────────────────────────────────

  private renderSystemPrompt(): string | null {
    const systemPrompt = this.context.systemPrompt;
    if (!systemPrompt?.content?.trim()) {
      return null;
    }

    const headingLabel = systemPrompt.label || this.formatSystemPromptLabel(systemPrompt.type);
    const lines: string[] = ['## System Prompt', '', `### ${headingLabel}`, '', '```text'];
    systemPrompt.content.split(/\r?\n/).forEach((line) => {
      lines.push(line);
    });
    lines.push('```');

    return lines.join('\n');
  }

  private formatSystemPromptLabel(type: string): string {
    if (!type) {
      return 'System Prompt';
    }
    return this.capitalize(type.replace(/[-_]/g, ' '));
  }

  private capitalize(value: string): string {
    if (!value) {
      return '';
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Context files
  // ────────────────────────────────────────────────────────────────────────────

  private renderContextFiles(options: ChatExportOptions): string | null {
    const files = this.context.contextFiles || [];
    if (files.length === 0) {
      return null;
    }

    const lines: string[] = ['## Context Files', ''];

    files.forEach((file, index) => {
      lines.push(`- [[${file.path}]]`);

      if (options.includeContextFileContents && file.content?.trim()) {
        lines.push('');
        lines.push('```text');
        file.content.split(/\r?\n/).forEach((line) => {
          lines.push(line);
        });
        lines.push('```');

        if (index !== files.length - 1) {
          lines.push('');
        }
      }
    });

    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Conversation
  // ────────────────────────────────────────────────────────────────────────────

  private renderConversation(options: ChatExportOptions): string | null {
    const messages = this.context.messages || [];
    const lines: string[] = ['## Conversation'];

    let visibleIndex = 0;
    messages.forEach((message) => {
      if (!this.shouldIncludeMessage(message.role, options)) {
        return;
      }

      visibleIndex += 1;
      lines.push('');
      lines.push(`### ${visibleIndex}. ${this.capitalize(message.role)}`);

      const body = this.renderMessageBody(message, options);
      if (body.length === 0) {
        lines.push('');
        lines.push('_(No content)_');
        return;
      }

      lines.push('');
      lines.push(...body);
    });

    if (visibleIndex === 0) {
      lines.push('');
      lines.push('_No messages exported._');
    }

    return lines.join('\n');
  }

  private shouldIncludeMessage(role: string, options: ChatExportOptions): boolean {
    switch (role) {
      case 'assistant':
        return options.includeAssistantMessages;
      case 'user':
        return options.includeUserMessages;
      case 'tool':
        return options.includeToolMessages;
      case 'system':
        return true;
      default:
        return true;
    }
  }

  private renderMessageBody(
    message: { content: string | MultiPartContent[] | null; role: string; messageParts?: MessagePart[]; reasoning?: string; tool_calls?: ToolCall[] },
    options: ChatExportOptions
  ): string[] {
    const output: string[] = [];
    const parts = MessagePartNormalizer.toParts(message as any);

    if (!parts || parts.length === 0) {
      this.appendContent(output, message.content, options);
      return output;
    }

    let reasoningBuffer: string[] = [];

    const flushReasoning = () => {
      if (!options.includeReasoning || reasoningBuffer.length === 0) {
        reasoningBuffer = [];
        return;
      }
      this.pushBlock(output, ['```reasoning', ...reasoningBuffer.join('').split(/\r?\n/), '```']);
      reasoningBuffer = [];
    };

    parts.forEach((part) => {
      switch (part.type) {
        case 'reasoning':
          reasoningBuffer.push(String(part.data ?? ''));
          break;
        case 'tool_call':
          flushReasoning();
          if (options.includeToolCalls) {
            this.appendToolCall(output, part.data as ToolCall, options);
          }
          break;
        case 'content':
          flushReasoning();
          this.appendContent(output, part.data as string | MultiPartContent[], options);
          break;
        default:
          flushReasoning();
          break;
      }
    });

    flushReasoning();
    return output;
  }

  private appendToolCall(lines: string[], toolCall: ToolCall, options: ChatExportOptions): void {
    if (!toolCall) return;

    const name = toolCall.request?.function?.name || toolCall.request?.id || toolCall.id;
    const state = toolCall.state || 'unknown';
    const headerLines = [`**Tool Call • ${name} (${state})**`];
    if (toolCall.serverId) {
      headerLines.push(`Server: ${toolCall.serverId}`);
    }
    this.pushBlock(lines, headerLines);

    if (options.includeToolCallArguments) {
      const args = toolCall.request?.function?.arguments;
      if (args && args.trim()) {
        const jsonLines = this.formatAsPrettyJson(args);
        this.pushBlock(lines, ['Arguments:', '```json', ...jsonLines, '```']);
      }
    }

    if (options.includeToolCallResults) {
      const result = toolCall.result;
      if (result) {
        if (result.success && result.data !== undefined) {
          this.pushBlock(lines, ['Result:', '```json', ...this.formatAsPrettyJson(result.data), '```']);
        } else if (result.error) {
          this.pushBlock(lines, ['Error:', '```json', ...this.formatAsPrettyJson(result.error), '```']);
        } else {
          this.pushBlock(lines, ['Result:', '```json', ...this.formatAsPrettyJson(result), '```']);
        }
      }
    }
  }

  private appendContent(
    lines: string[],
    content: string | MultiPartContent[] | null,
    options: ChatExportOptions
  ): void {
    const segments = this.normalizeContentSegments(content, options);
    segments.forEach((segment) => {
      if (!segment || !segment.trim()) return;
      this.pushBlock(lines, segment.split(/\r?\n/));
    });
  }

  private normalizeContentSegments(
    content: string | MultiPartContent[] | null,
    options: ChatExportOptions
  ): string[] {
    if (!content) {
      return [];
    }

    if (typeof content === 'string') {
      return [content];
    }

    const segments: string[] = [];
    content.forEach((part) => {
      if (part.type === 'text') {
        segments.push(part.text);
      }
      if (part.type === 'image_url' && options.includeImages) {
        const url = part.image_url?.url;
        if (url) {
          segments.push(`![Image](${url})`);
        }
      }
    });
    return segments;
  }

  private formatAsPrettyJson(payload: unknown): string[] {
    if (typeof payload === 'string') {
      try {
        const parsed = JSON.parse(payload);
        return JSON.stringify(parsed, null, 2).split(/\r?\n/);
      } catch {
        return payload.split(/\r?\n/);
      }
    }

    try {
      return JSON.stringify(payload, null, 2).split(/\r?\n/);
    } catch {
      return [String(payload)];
    }
  }

  private pushBlock(target: string[], block: string[]): void {
    const trimmedBlock = block.slice();
    while (trimmedBlock.length > 0 && trimmedBlock[0] === '') {
      trimmedBlock.shift();
    }
    while (trimmedBlock.length > 0 && trimmedBlock[trimmedBlock.length - 1] === '') {
      trimmedBlock.pop();
    }
    if (trimmedBlock.length === 0) return;

    if (target.length > 0 && target[target.length - 1] !== '') {
      target.push('');
    }
    target.push(...trimmedBlock);
  }
}
