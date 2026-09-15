import { isRecord } from '../../studio/utils';
import { connectCodex, type CodexConnection, type CodexJson } from './CodexAppServer';
import { resolveCodexOptions, type CodexExecutionOptions } from './CodexExecutionSettings';
import { codexActivity, type CodexActivity } from './CodexActivity';
const activeThreads = new Set<string>();
export type CodexRequest = CodexExecutionOptions & { prompt: string; workingDirectory: string; threadId?: string; images?: string[]; dynamicTools?: CodexJson[]; recoverCompletedTurn?: boolean };
export type CodexResult = { threadId: string; turnId: string; text: string; status: string };
export type CodexCallbacks = {
  log: (text: string) => void;
  request: (method: string, params: CodexJson, signal: AbortSignal) => Promise<unknown>;
  thread: (threadId: string) => void | Promise<void>;
  text?: (text: string) => void;
  activity?: (activity: CodexActivity) => void;
  ready?: (control: { turnId: string; send: (text: string) => Promise<void> }) => void;
};

/** A single native turn. Codex alone owns authentication, tools, reasoning and history. */
export async function runLocalCodex(input: CodexRequest, signal: AbortSignal, callbacks: CodexCallbacks): Promise<CodexResult> {
  if (!input.prompt.trim() || input.prompt.length > 256_000) throw new Error('A Codex prompt must contain 1–256,000 characters.');
  const options = resolveCodexOptions(input);
  const approvalItems = new Map<string, CodexJson>();
  let connection: CodexConnection | undefined, threadId = '', turnId = '', text = '', streamingText = '', ownsThread = false;
  let complete!: (result: CodexResult) => void, fail!: (error: Error) => void;
  const completion = new Promise<CodexResult>((resolve, reject) => { complete = resolve; fail = reject; });
  void completion.catch(() => {});
  try {
    connection = await connectCodex(input.workingDirectory, signal, {
      error: error => fail(error),
      abort: async () => { if (threadId && turnId) await connection?.request('turn/interrupt', { threadId, turnId }); },
      request: (method, params, requestSignal) => callbacks.request(method, { ...params,
        ...(method === 'item/fileChange/requestApproval' && approvalItems.has(String(params.itemId)) ? { change: approvalItems.get(String(params.itemId)) } : {}) }, requestSignal),
      notification: (method, params) => {
        if (params.threadId !== threadId) return;
        const activity = codexActivity(method, params); if (activity) callbacks.activity?.(activity);
        if (method === 'item/started' && isRecord(params.item) && params.item.type === 'fileChange') {
          approvalItems.set(String(params.item.id), params.item);
          if (approvalItems.size > 16) approvalItems.delete(approvalItems.keys().next().value);
        }
        if (method === 'turn/started' && isRecord(params.turn)) turnId = String(params.turn.id || '');
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') { streamingText = (streamingText + params.delta).slice(-256_000); callbacks.text?.(streamingText); }
        if (method === 'item/completed' && isRecord(params.item)) {
          const item = params.item;
          if (item.type === 'agentMessage' && typeof item.text === 'string') {
            text = (text + (text ? '\n\n' : '') + item.text).slice(-256_000); callbacks.log(item.text.slice(-8000)); streamingText = `${text}\n\n`; callbacks.text?.(text);
          } else if (item.type === 'commandExecution') callbacks.log(`Command ${String(item.status)}: ${String(item.command).slice(0, 2000)}`);
          else if (item.type === 'fileChange') { approvalItems.delete(String(item.id)); callbacks.log(`File changes: ${String(item.status)}`); }
        }
        if (method === 'turn/completed' && isRecord(params.turn)) {
          const turn = params.turn;
          if (turn.status === 'completed') complete({ threadId, turnId: String(turn.id), text, status: 'completed' });
          else fail(new Error(`Codex ${String(turn.status)}: ${isRecord(turn.error) ? String(turn.error.message) : 'Turn did not complete.'} Thread: ${threadId}`));
        }
      },
    });
    callbacks.log(`Connected to on-machine Codex · ${options.model} · ${options.effort} · ${options.serviceTier === 'default' ? 'Normal' : 'Fast'}`);
    const parameters = { model: options.model, cwd: input.workingDirectory,
      serviceTier: options.serviceTier,
      config: { model_reasoning_effort: options.effort },
    };
    // Resumes otherwise restore historic permissions. Ask Codex to resolve today's
    // native config in an ephemeral thread, then transfer its exact policy unchanged.
    // No model turn runs in the temporary thread and no plugin approval setting enters this path.
    if (input.threadId && input.recoverCompletedTurn) {
      const saved = await connection.request('thread/read', { threadId: input.threadId, includeTurns: true });
      const turns = isRecord(saved.thread) && Array.isArray(saved.thread.turns) ? saved.thread.turns : [];
      const last = turns[turns.length - 1];
      if (isRecord(last) && last.status === 'completed') {
        const items = Array.isArray(last.items) ? last.items : [];
        const recoveredText = items.filter(item => isRecord(item) && item.type === 'agentMessage' && typeof item.text === 'string').map(item => String(item.text)).join('\n\n').slice(-256_000);
        return { threadId: input.threadId, turnId: String(last.id), text: recoveredText, status: 'completed' };
      }
      if (isRecord(last) && last.status === 'inProgress') throw new Error('The saved native turn is still active. Reconnect after Codex finishes; Studio will not start a duplicate turn.');
    }
    const native = input.threadId ? await connection.request('thread/start', { ...parameters, ephemeral: true }) : undefined;
    if (native && (native.approvalPolicy == null || typeof native.approvalsReviewer !== 'string' || !isRecord(native.sandbox))) {
      throw new Error('Codex did not resolve its configured permissions.');
    }
    const profile = native && isRecord(native.activePermissionProfile) ? native.activePermissionProfile.id : undefined;
    const thread = await connection.request(input.threadId ? 'thread/resume' : 'thread/start', {
      ...(!input.threadId && input.dynamicTools?.length ? { dynamicTools: input.dynamicTools } : {}),
      ...parameters, ...(input.threadId ? { threadId: input.threadId, approvalPolicy: native!.approvalPolicy,
        approvalsReviewer: native!.approvalsReviewer, ...(typeof profile === 'string' ? { permissions: profile } : {}) } : {}),
    });
    if (!isRecord(thread.thread) || typeof thread.thread.id !== 'string') throw new Error('Codex returned no thread identity.');
    threadId = thread.thread.id;
    if (activeThreads.has(threadId)) throw new Error('This Codex thread is already running in another Studio or chat view.');
    activeThreads.add(threadId); ownsThread = true; await callbacks.thread(threadId); callbacks.log(`Codex thread: ${threadId}`);
    const started = await connection.request('turn/start', { threadId, model: options.model, effort: options.effort, serviceTierForTurn: options.serviceTier,
      ...(native && typeof profile !== 'string' ? { sandboxPolicy: native.sandbox } : {}),
      input: [{ type: 'text', text: input.prompt, text_elements: [] }, ...(input.images || []).map(url => ({ type: 'image', url }))] });
    if (isRecord(started.turn)) turnId = String(started.turn.id || turnId);
    callbacks.ready?.({ turnId, send: async message => {
      if (!message.trim() || message.length > 16_000) throw new Error('A run message must contain 1–16,000 characters.');
      await connection!.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text: message, text_elements: [] }] });
    } });
    return await completion;
  } finally { if (ownsThread) activeThreads.delete(threadId); connection?.close(); }
}
