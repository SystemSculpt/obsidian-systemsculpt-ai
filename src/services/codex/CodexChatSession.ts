import type { ChatMessage } from "../../types";
import type { App } from 'obsidian';
import { runLocalCodex } from './LocalCodexClient';
import { answerCodexRequest } from './CodexRequestModal';
import type { CodexExecutionOptions } from './CodexExecutionSettings';
import { LocalAgentChatSession } from './LocalAgentChatSession';

/** Chat presentation adapter. Codex owns every model step, tool and durable thread. */
export class CodexChatSession extends LocalAgentChatSession {
  constructor(app: App, localOptions: { persistAssistant: (message: ChatMessage) => Promise<void> }, forkHistory: () => readonly ChatMessage[] = () => [], executionOptions: () => CodexExecutionOptions = () => ({})) {
    super(app, 'codex', localOptions, forkHistory, (turn, signal, events) => runLocalCodex({ ...executionOptions(), ...turn }, signal, {
      thread: events.thread,
      log: text => events.status(text.startsWith('Command ') ? text : 'Codex is working'),
      text: events.text,
      request: (method, params, requestSignal) => events.waitFor(() => answerCodexRequest(app, method, params, requestSignal)),
    }));
  }
}
