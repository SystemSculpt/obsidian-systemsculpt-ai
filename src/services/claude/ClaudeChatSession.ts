import type { ChatMessage } from "../../types";
import type { App } from 'obsidian';
import { LocalAgentChatSession } from '../codex/LocalAgentChatSession';
import { runLocalClaude, type ClaudeExecutionOptions } from './LocalClaudeClient';
import { answerClaudePermission } from './ClaudeRequestModal';

/** Chat presentation adapter. Claude Code owns every model step, tool, permission and durable session. */
export class ClaudeChatSession extends LocalAgentChatSession {
  constructor(app: App, localOptions: { persistAssistant: (message: ChatMessage) => Promise<void> }, forkHistory: () => readonly ChatMessage[] = () => [], executionOptions: () => ClaudeExecutionOptions = () => ({})) {
    super(app, 'claude', localOptions, forkHistory, (turn, signal, events) => runLocalClaude({ ...executionOptions(), prompt: turn.prompt, images: turn.images, workingDirectory: turn.workingDirectory, sessionId: turn.threadId }, signal, {
      session: events.thread,
      log: text => events.status(text.startsWith('Tool: ') ? text.slice(6) : 'Claude Code is working'),
      text: events.text,
      permission: (request, requestSignal) => events.waitFor(() => answerClaudePermission(app, request, requestSignal)),
    }));
  }
}
