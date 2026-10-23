import { isRecord } from '../../studio/utils';
import { connectCodex, type CodexConnection, type CodexJson } from './CodexAppServer';
import { resolveCodexOptions, type CodexExecutionOptions } from './CodexExecutionSettings';
import { codexActivity, type CodexActivity } from './CodexActivity';
import { codexApprovalParameters, resolveCodexApprovalMode } from './CodexApprovalPolicy';
const activeThreads = new Set<string>();
export type CodexRequest = CodexExecutionOptions & { approvalMode?: string; prompt: string; workingDirectory: string; threadId?: string; images?: readonly string[]; dynamicTools?: readonly CodexJson[]; recoverCompletedTurn?: boolean };
export type CodexResult = { threadId: string; turnId: string; text: string; status: string };
export type CodexCallbacks = {
  log: (text: string) => void;
  request: (method: string, params: CodexJson, signal: AbortSignal, requestId?: string | number) => Promise<unknown>;
  thread: (threadId: string) => void | Promise<void>;
  /** Tail snapshot plus its absolute character offset in this turn's text. */
  text?: (text: string, offset?: number) => void;
  activity?: (activity: CodexActivity, item?: CodexJson) => void;
  ready?: (control: { turnId: string; send: (text: string) => Promise<void> }) => void;
};

type CodexLiveConnection = {
  threadId: string;
  key: string;
  next: (input: CodexRequest, signal: AbortSignal, callbacks: CodexCallbacks) => Promise<CodexResult>;
  close: () => Promise<void>;
};
const codexConnectionKey = (input: CodexRequest) => JSON.stringify([input.workingDirectory, resolveCodexOptions(input), 'approvalMode' in input ? input.approvalMode : undefined, input.dynamicTools]);

/** Keep the loaded native thread (and its native approval scopes) alive only while this chat is attached. */
export class CodexChatTransport {
  connection?: CodexLiveConnection;
  closing: Promise<void> = Promise.resolve();
  private used = false;
  private running = false;
  constructor(private readonly notice?: (message: string) => void) {}
  async run(input: CodexRequest, signal: AbortSignal, callbacks: CodexCallbacks): Promise<CodexResult> {
    if (this.running) throw new Error('Wait for the current Codex response to finish.');
    this.running = true;
    try {
      await this.closing;
      if (signal.aborted) throw new Error('Codex run canceled.');
      if (this.connection && (this.connection.key !== codexConnectionKey(input) || this.connection.threadId !== input.threadId)) await this.close();
      if (!this.connection && this.used) this.notice?.('Codex started a new native session. Previous session approvals no longer apply.');
      this.used = true;
      return await runLocalCodex(input, signal, callbacks, this);
    } finally { this.running = false; }
  }
  async close(): Promise<void> { const connection = this.connection; this.connection = undefined; if (connection) this.closing = connection.close(); await this.closing; }
}

/** A single native turn by default; chat may explicitly retain the native app-server. */
export async function runLocalCodex(input: CodexRequest, signal: AbortSignal, callbacks: CodexCallbacks, owner?: CodexChatTransport): Promise<CodexResult> {
  if (!input.prompt.trim() || input.prompt.length > 256_000) throw new Error('A Codex prompt must contain 1–256,000 characters.');
  if (signal.aborted) throw new Error('Codex run canceled.');
  if (owner?.connection) return owner.connection.next(input, signal, callbacks);
  const options = resolveCodexOptions(input);
  // Chat supplies its Auto default explicitly; Studio keeps native inheritance.
  const approvalMode = resolveCodexApprovalMode(input.approvalMode ?? 'settings');
  const approvalParameters = codexApprovalParameters(approvalMode, input.workingDirectory);
  const approvalItems = new Map<string, CodexJson>();
  let connection: CodexConnection | undefined, threadId = '', turnId = '', text = '', streamingText = '', lockedThreadId = '';
  let textLength = 0, streamedItemLength = 0;
  let liveConnection: CodexLiveConnection | undefined, retained = false, active = true, closed = false, previousTurnId = '';
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  if (owner) signal.addEventListener('abort', abort, { once: true });
  const claimThread = (id: string) => {
    if (activeThreads.has(id)) throw new Error('This Codex thread is already running in another Studio or chat view.');
    activeThreads.add(id); lockedThreadId = id;
  };
  let complete!: (result: CodexResult) => void, fail!: (error: Error) => void;
  let completion = new Promise<CodexResult>((resolve, reject) => { complete = resolve; fail = reject; });
  void completion.catch(() => {});
  try {
    // Reserve a known thread before resume can change its native configuration.
    if (input.threadId) claimThread(input.threadId);
    connection = await connectCodex(input.workingDirectory, owner ? lifetime.signal : signal, {
      error: error => {
        active = false; closed = true;
        if (owner && connection) owner.closing = connection.closed;
        if (owner && owner.connection === liveConnection) owner.connection = undefined;
        fail(error);
      },
      abort: async () => { if (threadId && turnId) await connection?.request('turn/interrupt', { threadId, turnId }); },
      request: (method, params, requestSignal, requestId) => {
        if (!active || params.threadId !== threadId || params.turnId && (params.turnId === previousTurnId || turnId && params.turnId !== turnId)) return Promise.reject(new Error('Native approval withdrawn.'));
        return callbacks.request(method, { ...params,
          ...(method === 'item/fileChange/requestApproval' && approvalItems.has(String(params.itemId)) ? { change: approvalItems.get(String(params.itemId)) } : {}) }, requestSignal, requestId);
      },
      notification: (method, params) => {
        const eventTurnId = isRecord(params.turn) ? params.turn.id : params.turnId;
        if (!active || params.threadId !== threadId || eventTurnId && (eventTurnId === previousTurnId || turnId && eventTurnId !== turnId)) return;
        const activity = codexActivity(method, params); if (activity) callbacks.activity?.(activity, isRecord(params.item) ? params.item : undefined);
        if (method === 'item/started' && isRecord(params.item) && params.item.type === 'fileChange') {
          approvalItems.set(String(params.item.id), params.item);
        }
        if (method === 'turn/started' && isRecord(params.turn)) turnId = String(params.turn.id || '');
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          const separator = textLength ? '\n\n' : '';
          if (owner) callbacks.text?.((streamedItemLength ? '' : separator) + params.delta, textLength + (streamedItemLength ? separator.length + streamedItemLength : 0));
          streamedItemLength += params.delta.length;
          streamingText = (streamingText + params.delta).slice(-256_000);
          if (!owner) callbacks.text?.(streamingText);
        }
        if (method === 'item/completed' && isRecord(params.item)) {
          const item = params.item;
          if (item.type === 'agentMessage' && typeof item.text === 'string') {
            const segment = (textLength ? '\n\n' : '') + item.text;
            if (owner) callbacks.text?.(segment, textLength);
            textLength += segment.length; streamedItemLength = 0;
            text = (text + (text ? '\n\n' : '') + item.text).slice(-256_000); callbacks.log(item.text.slice(-8000)); streamingText = `${text}\n\n`;
            if (!owner) callbacks.text?.(text);
          } else if (item.type === 'commandExecution') callbacks.log(`Command ${String(item.status)}: ${String(item.command).slice(0, 2000)}`);
          else if (item.type === 'fileChange') { approvalItems.delete(String(item.id)); callbacks.log(`File changes: ${String(item.status)}`); }
        }
        if (method === 'turn/completed' && isRecord(params.turn)) {
          active = false;
          const turn = params.turn;
          if (turn.status === 'completed') complete({ threadId, turnId: String(turn.id), text, status: 'completed' });
          else fail(new Error(`Codex ${String(turn.status)}: ${isRecord(turn.error) ? String(turn.error.message) : 'Turn did not complete.'} Thread: ${threadId}`));
        }
      },
    });
    void connection.closed.then(() => { if (lockedThreadId) activeThreads.delete(lockedThreadId); });
    callbacks.log(`Connected to on-machine Codex · ${options.model} · ${options.effort} · ${options.serviceTier === 'default' ? 'Normal' : 'Fast'}`);
    const parameters = { model: options.model, cwd: input.workingDirectory,
      serviceTier: options.serviceTier,
      config: { model_reasoning_effort: options.effort },
    };
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
    // Settings resumes refresh historic permissions from today's native config.
    // The ephemeral thread resolves policy only; it never runs a model turn.
    const native = input.threadId && approvalMode === 'settings' ? await connection.request('thread/start', { ...parameters, ephemeral: true }) : undefined;
    if (native && (native.approvalPolicy == null || typeof native.approvalsReviewer !== 'string' || !isRecord(native.sandbox))) {
      throw new Error('Codex did not resolve its configured permissions.');
    }
    const profile = native && isRecord(native.activePermissionProfile) ? native.activePermissionProfile.id : undefined;
    const thread = await connection.request(input.threadId ? 'thread/resume' : 'thread/start', {
      ...(!input.threadId && input.dynamicTools?.length ? { dynamicTools: input.dynamicTools } : {}),
      ...parameters, ...approvalParameters.thread, ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(native ? { approvalPolicy: native.approvalPolicy,
        approvalsReviewer: native.approvalsReviewer, ...(typeof profile === 'string' ? { permissions: profile } : {}) } : {}),
    });
    if (!isRecord(thread.thread) || typeof thread.thread.id !== 'string') throw new Error('Codex returned no thread identity.');
    threadId = thread.thread.id;
    if (input.threadId && threadId !== input.threadId) throw new Error('Codex resumed a different thread than requested.');
    if (!lockedThreadId) claimThread(threadId);
    await callbacks.thread(threadId); callbacks.log(`Codex thread: ${threadId}`);
    const startTurn = async (): Promise<CodexResult> => {
      const started = await connection!.request('turn/start', { threadId, model: options.model, effort: options.effort, serviceTierForTurn: options.serviceTier,
        ...approvalParameters.turn, ...(native && typeof profile !== 'string' ? { sandboxPolicy: native.sandbox } : {}),
        input: [{ type: 'text', text: input.prompt, text_elements: [] }, ...(input.images || []).map(url => ({ type: 'image', url }))] });
      if (isRecord(started.turn)) turnId = String(started.turn.id || turnId);
      const currentTurnId = turnId;
      callbacks.ready?.({ turnId, send: async message => {
        if (!active || turnId !== currentTurnId) throw new Error('This Codex turn is no longer active.');
        if (!message.trim() || message.length > 16_000) throw new Error('A run message must contain 1–16,000 characters.');
        await connection!.request('turn/steer', { threadId, expectedTurnId: currentTurnId, input: [{ type: 'text', text: message, text_elements: [] }] });
      } });
      return completion;
    };
    if (owner) {
      liveConnection = {
        threadId, key: codexConnectionKey(input),
        close: () => { if (active) lifetime.abort(); else connection!.close(); return connection!.closed; },
        next: async (nextInput, nextSignal, nextCallbacks) => {
          if (active || closed) throw new Error('Codex connection is not ready for another turn.');
          if (nextSignal.aborted) throw new Error('Codex run canceled.');
          input = nextInput; signal = nextSignal; callbacks = nextCallbacks;
          previousTurnId = turnId; turnId = ''; text = ''; streamingText = ''; textLength = 0; streamedItemLength = 0; approvalItems.clear(); active = true;
          completion = new Promise<CodexResult>((resolve, reject) => { complete = resolve; fail = reject; });
          void completion.catch(() => {});
          signal.addEventListener('abort', abort, { once: true });
          let succeeded = false;
          try { const result = await startTurn(); succeeded = true; return result; }
          finally { signal.removeEventListener('abort', abort); active = false; if (!succeeded) { connection!.close(); await connection!.closed; } }
        },
      };
      owner.connection = liveConnection;
    }
    const result = await startTurn();
    retained = Boolean(owner && !closed);
    return result;
  } finally {
    signal.removeEventListener('abort', abort); active = false;
    if (!retained) { connection?.close(); await connection?.closed; if (lockedThreadId) activeThreads.delete(lockedThreadId); }
  }
}
