import { App } from 'obsidian';
import { ChatMessage } from '../types';
import { ToolCall } from '../types/toolCalls';

describe('ContextFileService tool result enrichment', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('builds tool result messages even when message lacks result but ToolCallManager has it', async () => {
    const systemPromptMock = jest.fn().mockResolvedValue('system prompt');

    jest.doMock('../services/SystemPromptService', () => ({
      SystemPromptService: {
        getInstance: jest.fn(() => ({
          getSystemPromptContent: systemPromptMock,
        })),
      },
    }));

    const { ContextFileService: ServiceUnderTest } = await import('../services/ContextFileService');
    const service = new ServiceUnderTest(new App());

    const toolCallId = 'call_test_tool';
    const baseToolCall: ToolCall = {
      id: toolCallId,
      messageId: 'assistant-1',
      request: {
        id: toolCallId,
        type: 'function',
        function: { name: 'read', arguments: '{"path":"todo-list.md"}' },
      },
      state: 'completed',
      timestamp: Date.now(),
      autoApproved: true,
    } as ToolCall;

    const toolCallWithResult: ToolCall = {
      ...baseToolCall,
      executionCompletedAt: Date.now(),
      result: {
        success: true,
        data: { content: '- [ ] Task A' },
      },
    };

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'Explore todo list',
        message_id: 'user-1',
      },
      {
        role: 'assistant',
        content: '',
        message_id: 'assistant-1',
        tool_calls: [{ ...baseToolCall }],
      },
    ];

    const toolCallManagerStub = {
      getToolCall: jest.fn((id: string) => (id === toolCallId ? toolCallWithResult : undefined)),
      getToolResultsForContext: jest.fn(() => [toolCallWithResult]),
      getArchivedToolResultsSummary: jest.fn(() => ''),
    };

	    const prepared = await service.prepareMessagesWithContext(
	      messages,
	      new Set(),
	      undefined,
	      undefined,
	      true,
	      true,
	      toolCallManagerStub
	    );

    const toolMessages = prepared.filter((msg) => msg.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].tool_call_id).toBe(toolCallId);
    expect(toolMessages[0].content).toContain('Task A');
  });
});
