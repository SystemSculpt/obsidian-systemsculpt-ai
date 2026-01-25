import { ChatExportBuilder } from '../ChatExportBuilder';
import { ChatExportContext } from '../ChatExportTypes';
import { createDefaultChatExportOptions } from '../../../../types/chatExport';
import { ChatMessage } from '../../../../types';
import { ToolCall } from '../../../../types/toolCalls';

describe('ChatExportBuilder', () => {
  const toolCall: ToolCall = {
    id: 'tool-1',
    messageId: 'assistant-1',
    request: {
      id: 'tool-1',
      type: 'function',
      function: {
        name: 'searchVault',
        arguments: '{"path":"Notes"}'
      }
    },
    state: 'completed',
    timestamp: 1,
    executionStartedAt: 2,
    executionCompletedAt: 3,
    result: {
      success: true,
      data: {
        summary: 'Found 3 matching files'
      }
    }
  };

  const userMessage: ChatMessage = {
    role: 'user',
    content: 'Can you show code?\n```ts\nconsole.log("hi");\n```',
    message_id: 'user-1'
  };

  const assistantMessage: ChatMessage = {
    role: 'assistant',
    content: null,
    message_id: 'assistant-1',
    messageParts: [
      { id: 'reason-1', type: 'reasoning', timestamp: 10, data: 'Assess user question and gather context.' },
      { id: 'tool-1', type: 'tool_call', timestamp: 11, data: toolCall },
      { id: 'content-1', type: 'content', timestamp: 12, data: 'Here is the answer with code.\n```ts\nconst value = 1;\n```' }
    ],
    tool_calls: [toolCall],
    webSearchEnabled: true
  };

  const context: ChatExportContext = {
    title: 'Exported Chat',
    chatId: 'chat-123',
    chatVersion: 4,
    exportedAt: new Date('2025-09-17T10:15:00Z'),
    model: {
      id: 'systemsculpt@@gpt-4o',
      label: 'SystemSculpt Pro (gpt-4o)'
    },
    webSearchEnabled: true,
    systemPrompt: {
      type: 'general-use',
      label: 'General Use',
      content: 'You are a helpful assistant.'
    },
    contextFiles: [
      {
        path: 'Docs/guide.md',
        content: '# Guide\nContent line one.\nContent line two.'
      }
    ],
    messages: [userMessage, assistantMessage],
    summary: {
      totalMessages: 2,
      assistantMessages: 1,
      userMessages: 1,
      toolMessages: 0,
      toolCallCount: 1,
      reasoningBlockCount: 1,
      imageCount: 0
    }
  };

  test('renders front matter, headings, reasoning fence, tool details, and preserves markdown content', () => {
    const builder = new ChatExportBuilder(context);
    const markdown = builder.build(createDefaultChatExportOptions());

    expect(markdown.startsWith('---\n')).toBe(true);
    expect(markdown).toContain('title: "Exported Chat"');
    expect(markdown).toContain('model:');
    expect(markdown).toContain('label: "SystemSculpt Pro (gpt-4o)"');

    expect(markdown).toContain('## Summary');
    expect(markdown).toContain('## Context Files');
    expect(markdown).toContain('- [[Docs/guide.md]]');
    expect(markdown).toContain('```text\n# Guide');

    expect(markdown).toContain('## Conversation');
    expect(markdown).toContain('### 1. User');
    expect(markdown).toContain('Can you show code?');
    expect(markdown).toContain('```ts');
    expect(markdown).toContain('const value = 1;');

    expect(markdown).toContain('### 2. Assistant');
    expect(markdown).toContain('```reasoning');
    expect(markdown).toContain('Assess user question and gather context.');
    expect(markdown).toContain('**Tool Call • searchVault (completed)**');
    expect(markdown).toContain('```json');
    expect(markdown).toContain('"path": "Notes"');
  });

  test('omits reasoning blocks when includeReasoning is false', () => {
    const builder = new ChatExportBuilder(context);
    const options = createDefaultChatExportOptions();
    options.includeReasoning = false;

    const markdown = builder.build(options);

    expect(markdown).not.toContain('```reasoning');
    expect(markdown).not.toContain('Assess user question and gather context.');
  });

  test('omits tool call details when includeToolCalls is false', () => {
    const builder = new ChatExportBuilder(context);
    const options = createDefaultChatExportOptions();
    options.includeToolCalls = false;

    const markdown = builder.build(options);

    expect(markdown).not.toContain('Tool Call • searchVault');
    expect(markdown).not.toContain('```json');
  });

  test('omits context file contents while retaining links when includeContextFileContents is false', () => {
    const builder = new ChatExportBuilder(context);
    const options = createDefaultChatExportOptions();
    options.includeContextFileContents = false;

    const markdown = builder.build(options);

    expect(markdown).toContain('[[Docs/guide.md]]');
    const contextSection = markdown.split('## Context Files')[1]?.split('## Conversation')[0] ?? '';
    expect(contextSection).not.toContain('```text');
    expect(contextSection).not.toContain('Content line one.');
  });
});
