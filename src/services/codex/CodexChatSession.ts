import type { ChatMessage } from "../../types";
import type { App } from 'obsidian';
import { CodexChatTransport } from './LocalCodexClient';
import { isRecord } from '../../studio/utils';
import { codexToolActivity } from './CodexActivity';
import type { CodexExecutionOptions } from './CodexExecutionSettings';
import { LocalAgentChatSession } from './LocalAgentChatSession';

/** Chat presentation adapter. Codex owns every model step, tool and durable thread. */
export class CodexChatSession extends LocalAgentChatSession {
  constructor(app: App, localOptions: { persistAssistant: (message: ChatMessage) => Promise<void>; notice?: (text: string) => void }, forkHistory: () => readonly ChatMessage[] = () => [], executionOptions: () => CodexExecutionOptions & { approvalMode?: string } = () => ({})) {
    const transport = new CodexChatTransport(localOptions.notice);
    super(app, 'codex', localOptions, forkHistory, (turn, signal, events) => transport.run({ approvalMode: 'auto', ...executionOptions(), ...turn }, signal, {
      thread: events.thread,
      log: text => events.status(text.startsWith('Command ') ? text : 'Codex is working'),
      text: events.text,
      activity: (activity, item) => { const update = codexToolActivity(activity, item, turn.workingDirectory); if (update) events.tool(update); },
      request: async (method, params, requestSignal, requestId) => {
        const permissions = method === 'item/permissions/requestApproval', question = method === 'item/tool/requestUserInput';
        if (!permissions && !question && !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) throw new Error(`Chat does not support the Codex client request ${method}.`);
        const change = isRecord(params.change) ? params.change : {};
        const decision = await events.approval({
          callId: String(params.itemId ?? requestId ?? method), name: question ? 'request_user_input' : permissions ? 'request_permissions' : method.split('/')[1],
          input: { ...change, ...params }, state: 'approval-required',
          native: { agent: 'codex', workingDirectory: typeof params.cwd === 'string' ? params.cwd : turn.workingDirectory, requestMethod: method, requestId },
        }, requestSignal, !question);
        if (question) return { answers: Object.fromEntries(Object.entries(decision.approved ? decision.answers ?? {} : {}).map(([id, answers]) => [id, { answers }])) };
        if (permissions) return { permissions: decision.approved && isRecord(params.permissions) ? params.permissions : {}, scope: decision.approved && decision.rememberForSession ? 'session' : 'turn' };
        return { decision: decision.approved ? decision.rememberForSession ? 'acceptForSession' : 'accept' : 'decline' };
      },
    }), () => transport.close());
  }
}
