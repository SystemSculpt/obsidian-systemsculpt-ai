import type { ChatMessage } from "../../types";
import type { App } from 'obsidian';
import { CodexChatTransport } from './LocalCodexClient';
import { isRecord } from '../../utils/jsonRecord';
import { codexToolActivity } from './CodexActivity';
import { codexClientRequestKind, codexClientResponse } from './CodexClientRequests';
import type { CodexExecutionOptions } from './CodexExecutionSettings';
import { LocalAgentChatSession } from './LocalAgentChatSession';
import { encodeSystemSculptToolResult, type SystemSculptToolResult, type SystemSculptToolset } from '../../tools/systemsculpt/SystemSculptTools';
import { isChangingSystemSculptTool } from '../../utils/toolPolicy';

const toolReply = (result: SystemSculptToolResult) => ({ success: result.ok || Boolean(result.link), contentItems: [{ type: 'inputText', text: encodeSystemSculptToolResult(result) }] });

/** Codex receives SystemSculpt tools as dynamic tools on a new native thread. */
function codexDynamicTools(toolset: SystemSculptToolset | undefined): Record<string, unknown>[] | undefined {
  return toolset?.definitions.map(tool => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

/** Chat presentation adapter. Codex owns every model step, tool and durable thread. */
export class CodexChatSession extends LocalAgentChatSession {
  constructor(app: App, localOptions: { persistAssistant: (message: ChatMessage) => Promise<void>; notice?: (text: string) => void }, forkHistory: () => readonly ChatMessage[] = () => [], executionOptions: () => CodexExecutionOptions & { approvalMode?: string } = () => ({}), tools?: () => SystemSculptToolset | undefined) {
    const transport = new CodexChatTransport(localOptions.notice);
    super(app, 'codex', localOptions, forkHistory, (turn, signal, events) => { const toolset = tools?.(); const dynamicTools = codexDynamicTools(toolset); return transport.run({ approvalMode: 'auto', ...executionOptions(), ...turn, ...(dynamicTools ? { dynamicTools } : {}) }, signal, {
      thread: events.thread,
      log: text => events.status(text.startsWith('Command ') ? text : 'Codex is working'),
      text: events.text,
      activity: (activity, item) => { const update = codexToolActivity(activity, item, turn.workingDirectory); if (update) events.tool(update); },
      request: async (method, params, requestSignal, requestId) => {
        if (method === 'item/tool/call' && toolset) {
          const tool = String(params.tool ?? ''), callId = typeof params.callId === 'string' ? params.callId : undefined;
          // Dynamic tools skip Codex's own approvals, so Chat applies the chosen mode itself.
          const mode = executionOptions().approvalMode ?? 'auto';
          if (isChangingSystemSculptTool(tool) && mode === 'read-only') return toolReply({ ok: false, message: 'Read only: this would change vault files or spend credits, so it did not run.' });
          if (isChangingSystemSculptTool(tool) && mode !== 'auto') {
            const decision = await events.approval({
              callId: callId ?? String(requestId ?? tool), name: tool, input: isRecord(params.arguments) ? params.arguments : {}, state: 'approval-required',
              native: { agent: 'codex', workingDirectory: turn.workingDirectory, requestMethod: method, requestId },
            }, requestSignal, false);
            if (!decision.approved) return toolReply({ ok: false, message: 'The person declined this action.' });
          }
          return toolReply(await toolset.call(tool, params.arguments ?? {}, requestSignal, callId));
        }
        const kind = codexClientRequestKind(method);
        if (!kind) throw new Error(`Chat does not support the Codex client request ${method}.`);
        const permissions = kind === 'permissions', question = kind === 'question';
        const change = isRecord(params.change) ? params.change : {};
        const decision = await events.approval({
          callId: String(params.itemId ?? requestId ?? method), name: question ? 'request_user_input' : permissions ? 'request_permissions' : method.split('/')[1],
          input: { ...change, ...params }, state: 'approval-required',
          native: { agent: 'codex', workingDirectory: typeof params.cwd === 'string' ? params.cwd : turn.workingDirectory, requestMethod: method, requestId },
        }, requestSignal, !question);
        return codexClientResponse(kind, params, {
          action: decision.approved ? !question && decision.rememberForSession ? 'acceptForSession' : 'accept' : 'decline',
          answers: decision.answers,
        });
      },
    }); }, () => transport.close());
  }
}
