import type { ChatMessage } from "../../types";
import type { App } from 'obsidian';
import { LocalAgentChatSession } from '../codex/LocalAgentChatSession';
import { ClaudeChatTransport, claudeSessionPermissionUpdates, type ClaudeExecutionOptions } from './LocalClaudeClient';

/** Chat presentation adapter. Claude Code owns every model step, tool, permission and durable session. */
export class ClaudeChatSession extends LocalAgentChatSession {
  constructor(app: App, localOptions: { persistAssistant: (message: ChatMessage) => Promise<void>; notice?: (text: string, reason?: 'session-reset' | 'auto-unavailable') => void }, forkHistory: () => readonly ChatMessage[] = () => [], executionOptions: () => ClaudeExecutionOptions = () => ({})) {
    const transport = new ClaudeChatTransport(text => localOptions.notice?.(text, 'session-reset'));
    super(app, 'claude', localOptions, forkHistory, (turn, signal, events) => transport.run({ ...executionOptions(), prompt: turn.prompt, images: turn.images, workingDirectory: turn.workingDirectory, sessionId: turn.threadId }, signal, {
      session: events.thread,
      log: text => events.status(text.startsWith('Tool: ') ? text.slice(6) : 'Claude Code is working'),
      text: events.text,
      notice: text => localOptions.notice?.(text, 'auto-unavailable'),
      supportsQuestions: true,
      tool: activity => events.tool({ callId: activity.id, name: activity.name, input: activity.input, inputText: activity.inputText, state: activity.state,
        native: { agent: 'claude', workingDirectory: turn.workingDirectory },
        ...(activity.output === undefined ? {} : { output: { data: activity.output, ...(typeof activity.output === 'string' ? { summary: activity.output } : {}) } }) }),
      permission: (request, requestSignal) => events.approval({ callId: request.toolUseId || request.requestId || 'permission', name: request.toolName, input: request.input, state: 'approval-required',
        native: { agent: 'claude', workingDirectory: turn.workingDirectory, requestMethod: 'can_use_tool', requestId: request.requestId, description: request.description, permissionSuggestions: request.permissionSuggestions } }, requestSignal, claudeSessionPermissionUpdates(request).length > 0),
    }), () => transport.close());
  }
}
