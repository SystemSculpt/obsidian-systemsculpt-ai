import type { ChatMessage, MessagePart } from '../../types';
import type { App } from 'obsidian';
import type { ChatSession, AgentRunInput, AgentRunResult, ApprovalResponseOptions } from '../../chat/ChatSession';
import type { AgentConversationSnapshot, AgentPart, AgentToolPart } from '../../chat/ChatConversation';
import { THIN_AGENT_CONTRACT_VERSION, type MeasuredThinAgentContext, type ThinAgentContextSource, type ThinAgentContextResponse } from '../managed/ThinAgentV1Contract';
import { isRecord } from '../../studio/utils';
import { CodexThreadLocator } from './CodexThreadLocator';
import { localAgentChatDirectory } from './CodexExecutionSettings';
import { LOCAL_AGENTS, type LocalAgentId } from './LocalAgents';
import { resolveAbsoluteVaultPath } from '../../utils/vaultPathUtils';
import { localAgentPromptText } from './LocalAgentMessageParts';
import { desktopHost } from '../../platform/desktopOnly';

export type LocalAgentTurn = { prompt: string; images: string[]; workingDirectory: string; threadId?: string };
export type LocalAgentToolUpdate = Pick<AgentToolPart, 'callId' | 'state'> & Partial<Pick<AgentToolPart, 'name' | 'input' | 'inputText' | 'native' | 'output' | 'error'>>;
export type LocalAgentApprovalResponse = ApprovalResponseOptions & { approved: boolean };
export type LocalAgentTurnEvents = {
  /** Persist the native thread identity before the agent continues. */
  thread: (threadId: string) => Promise<void>;
  status: (label: string) => void;
  /** Replace the text tail at this absolute character offset (zero for a cumulative snapshot). */
  text: (text: string, offset?: number) => void;
  tool: (tool: LocalAgentToolUpdate) => void;
  approval: (tool: LocalAgentToolUpdate, signal: AbortSignal, grantsSessionScope?: boolean) => Promise<LocalAgentApprovalResponse>;
};
/** One native turn. The agent alone owns authentication, tools, reasoning, permissions and history. */
export type LocalAgentTurnRunner = (turn: LocalAgentTurn, signal: AbortSignal, events: LocalAgentTurnEvents) => Promise<{ text: string }>;

type PendingApproval = { callId: string; signal: AbortSignal; finish: (response?: LocalAgentApprovalResponse) => void };
const terminalToolStates = new Set(['succeeded', 'failed', 'denied', 'cancelled', 'outcome-unknown']);

/** Chat presentation adapter shared by on-machine agents. The agent owns every model step, tool and durable thread. */
export class LocalAgentChatSession implements ChatSession {
  private localSnapshot: AgentConversationSnapshot = { runId: null, turnId: null, status: 'idle', messages: [], parts: [] };
  /** Monotonic start of the current turn; the status row's elapsed time counts from here. */
  private runStartedAt: number | null = null;
  private readonly localListeners = new Set<(value: AgentConversationSnapshot) => void>();
  private readonly locator: CodexThreadLocator;
  private readonly approvals = new Map<string, PendingApproval>();
  private approvalSequence = 0;
  private localController: AbortController | null = null;
  private localCompletion: Promise<AgentRunResult> | null = null;
  private sources: readonly ThinAgentContextSource[] = [];
  private conversationId: string | null = null;
  readonly agentName: string;
  constructor(protected readonly app: App, readonly agent: LocalAgentId, private readonly localOptions: { persistAssistant: (message: ChatMessage) => Promise<void> }, protected readonly forkHistory: () => readonly ChatMessage[], private readonly runTurn: LocalAgentTurnRunner, private readonly closeTransport: () => void | Promise<void> = () => {}) {
    this.locator = new CodexThreadLocator(app, agent); this.agentName = LOCAL_AGENTS[agent];
  }
  getSnapshot(): AgentConversationSnapshot { return this.localSnapshot; }
  subscribe(listener: (value: AgentConversationSnapshot) => void): () => void { this.localListeners.add(listener); return () => this.localListeners.delete(listener); }
  private publish(patch: Partial<AgentConversationSnapshot>) {
    const elapsedMs = this.runStartedAt === null ? undefined : Math.max(0, Math.round(performance.now() - this.runStartedAt));
    this.localSnapshot = { ...this.localSnapshot, ...(elapsedMs === undefined ? {} : { elapsedMs }), ...patch };
    if (patch.status === 'completed' || patch.status === 'failed' || patch.status === 'cancelled') this.runStartedAt = null;
    for (const listener of this.localListeners) { try { listener(this.localSnapshot); } catch { /* Presentation must not interrupt the agent. */ } }
  }
  private publishParts(parts: readonly AgentPart[]) {
    this.publish({ parts, messages: this.localSnapshot.messages.map(message => ({ ...message, partIds: parts.filter(part => 'messageId' in part && part.messageId === message.id).map(part => part.id) })) });
  }
  private withdrawApprovals() { for (const pending of [...this.approvals.values()]) pending.finish(); }
  async hydrate(conversationId: string): Promise<void> {
    if (this.conversationId !== null && this.conversationId !== conversationId) { await this.cancel(); await this.closeTransport(); }
    this.conversationId = conversationId;
    await this.locator.read(conversationId);
  }
  async stageContext(_id: string, context: MeasuredThinAgentContext): Promise<ThinAgentContextResponse> {
    this.sources = context.sources;
    return { contract_version: THIN_AGENT_CONTRACT_VERSION, context_ref: `local-${this.agent}-context`, expires_at: new Date(Date.now() + 60_000).toISOString(), bytes: 0, sha256: '' };
  }
  start(input: AgentRunInput): Promise<AgentRunResult> {
    if (this.localController) return Promise.reject(new Error(`Wait for the current ${this.agentName} response to finish.`));
    const controller = new AbortController(); this.localController = controller;
    this.sources = [];
    this.localCompletion = this.execute(input, controller).finally(() => { this.localController = null; this.localCompletion = null; });
    return this.localCompletion;
  }
  private async execute(input: AgentRunInput, controller: AbortController): Promise<AgentRunResult> {
    const name = this.agentName, working = `${name} is working`, messageId = `${input.turnId}_assistant`;
    let accepting = true, receivedText = '', activeTextId: string | undefined, persisted = false;
    let vaultRoot: string | undefined, vaultRootAlias: string | undefined, homeDirectory: string | undefined;
    const nativeTerminalCalls = new Set<string>();
    const live = () => accepting && !controller.signal.aborted;
    const waiting = () => this.publish(this.approvals.size
      ? { status: 'waiting', phase: 'waiting', waitingReason: 'approval', statusLabel: `${name} needs your input` }
      : { status: 'running', phase: 'working', waitingReason: undefined, statusLabel: working });
    const tool = (update: LocalAgentToolUpdate) => {
      if (!live()) return;
      const terminal = terminalToolStates.has(update.state);
      if (terminal) for (const pending of [...this.approvals.values()]) if (pending.callId === update.callId) pending.finish();
      const previous = this.localSnapshot.parts.find((part): part is AgentToolPart => part.kind === 'tool' && part.callId === update.callId);
      // Approval withdrawal is not an execution result. A real native result supersedes that
      // presentation state; late starts cannot reopen it, nor a previously observed native result.
      const keepState = previous && (nativeTerminalCalls.has(update.callId) || terminalToolStates.has(previous.state) && !terminal
        || previous.state === 'approval-required' && !terminal || ['running', 'approved'].includes(previous.state) && update.state === 'input-streaming');
      const state = keepState ? previous.state : update.state;
      if (terminal) nativeTerminalCalls.add(update.callId);
      const mergedInput = isRecord(previous?.input) && isRecord(update.input) ? { ...previous.input, ...update.input } : update.input ?? previous?.input ?? {};
      const next: AgentToolPart = { id: `${messageId}_tool_${update.callId}`, order: this.localSnapshot.parts.length, kind: 'tool', messageId, location: 'server', ...previous, ...update,
        name: update.state === 'approval-required' && previous?.name && previous.name !== 'tool' ? previous.name : update.name || previous?.name || 'tool', state, input: mergedInput,
        native: update.native ? { ...previous?.native, ...update.native, vaultRoot, vaultRootAlias, homeDirectory } : previous?.native };
      if (!previous) activeTextId = undefined;
      this.publishParts(previous ? this.localSnapshot.parts.map(part => part.id === previous.id ? next : part) : [...this.localSnapshot.parts, next]);
    };
    const text = (value: string, offset = 0) => {
      if (!live()) return;
      const nextText = receivedText.slice(0, offset) + value;
      if (nextText === receivedText) return;
      let unchanged = Math.min(offset, receivedText.length);
      while (unchanged < receivedText.length && unchanged < nextText.length && receivedText[unchanged] === nextText[unchanged]) unchanged++;
      const replacing = unchanged < receivedText.length;
      receivedText = nextText;
      let parts = this.localSnapshot.parts;
      if (replacing) {
        // Canonical native text can correct a streamed tail. Trim only that text range,
        // leaving tool parts and the earlier text/tool ordering intact.
        let position = 0;
        activeTextId = undefined;
        parts = parts.flatMap((part): AgentPart[] => {
          if (part.kind !== 'text') return [part];
          const start = position; position += part.markdown.length;
          if (position <= unchanged) return [part];
          if (start > unchanged) return [];
          activeTextId = part.id;
          return [{ ...part, markdown: part.markdown.slice(0, unchanged - start) }];
        });
      }
      const delta = nextText.slice(unchanged), previous = parts.find(part => part.id === activeTextId);
      if (previous?.kind === 'text') this.publishParts(parts.map(part => part === previous ? { ...previous, markdown: previous.markdown + delta } : part));
      else if (delta) {
        const order = parts.reduce((last, part) => Math.max(last, part.order + 1), 0);
        activeTextId = `${messageId}_text_${order}`;
        this.publishParts([...parts, { id: activeTextId, order, kind: 'text', messageId, state: 'streaming', markdown: delta }]);
      } else this.publishParts(parts);
    };
    const approval = (update: LocalAgentToolUpdate, signal: AbortSignal, grantsSessionScope = true): Promise<LocalAgentApprovalResponse> => {
      if (!live() || signal.aborted) return Promise.reject(new Error('Native approval withdrawn.'));
      for (const pending of [...this.approvals.values()]) if (pending.callId === update.callId) pending.finish();
      const approvalId = `${input.turnId}_approval_${++this.approvalSequence}`;
      return new Promise((resolve, reject) => {
        const abort = () => finish();
        const finish = (response?: LocalAgentApprovalResponse) => {
          if (!this.approvals.delete(approvalId)) return;
          signal.removeEventListener('abort', abort);
          const decision = response ? response.approved ? 'approved' : 'denied' : 'withdrawn';
          this.publishParts(this.localSnapshot.parts.map(part => part.kind === 'tool' && part.approvalId === approvalId
            ? { ...part, state: response ? response.approved ? 'approved' : 'denied' : 'cancelled', approvalDecision: decision, approvalScope: response?.approved && response.rememberForSession && grantsSessionScope ? 'session' : undefined } : part));
          if (live()) waiting();
          if (response) resolve(response); else reject(new Error('Native approval withdrawn.'));
        };
        this.approvals.set(approvalId, { callId: update.callId, signal, finish });
        signal.addEventListener('abort', abort, { once: true });
        tool({ ...update, state: 'approval-required' });
        this.publishParts(this.localSnapshot.parts.map(part => part.kind === 'tool' && part.callId === update.callId ? { ...part, state: 'approval-required', approvalId, approvalDecision: undefined, approvalScope: undefined } : part));
        waiting();
      });
    };
    const stopApprovals = () => this.withdrawApprovals();
    controller.signal.addEventListener('abort', stopApprovals, { once: true });
    const finishParts = (outcome: 'completed' | 'cancelled' | 'failed') => {
      accepting = false; this.withdrawApprovals();
      this.publishParts(this.localSnapshot.parts.map(part => part.kind === 'text' ? { ...part, state: 'complete' }
        : part.kind === 'tool' && !terminalToolStates.has(part.state) ? { ...part, state: outcome === 'completed' ? 'outcome-unknown' : outcome } : part));
    };
    const message = (content: string, terminalOutcome?: 'cancelled' | 'failed'): ChatMessage => {
      const timestamp = Date.now();
      const messageParts: MessagePart[] = this.localSnapshot.parts.flatMap((part): MessagePart[] => {
        if (part.kind === 'text') return [{ id: part.id, type: 'content', timestamp: timestamp + part.order, data: part.markdown }];
        if (part.kind !== 'tool') return [];
        return [{ id: part.id, type: 'tool_call', timestamp: timestamp + part.order, data: {
          id: part.callId, messageId, timestamp: timestamp + part.order, executedOn: 'server', native: part.native, approvalDecision: part.approvalDecision, approvalScope: part.approvalScope,
          request: { id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } },
          state: part.state === 'succeeded' ? 'completed' : 'failed',
          result: { success: part.state === 'succeeded', data: part.output, ...(part.state === 'succeeded' ? {} : { error: part.error ?? { code: `NATIVE_TOOL_${part.state.toUpperCase().replace(/-/g, '_')}`, message: part.state === 'cancelled' && part.approvalDecision === 'withdrawn' ? 'Approval request withdrawn.' : `Native tool ${part.state}.` } }) },
        } }];
      });
      // Saved chats show "Worked 41s" and the folded activity's duration from this.
      const responseDurationMs = this.runStartedAt === null ? this.localSnapshot.elapsedMs : Math.round(performance.now() - this.runStartedAt);
      return { role: 'assistant', content, message_id: messageId, messageParts, ...(responseDurationMs === undefined ? {} : { responseDurationMs }), ...(terminalOutcome ? { terminalOutcome } : {}) };
    };
    this.runStartedAt = performance.now();
    this.publish({ runId: input.turnId, turnId: input.turnId, status: 'running', phase: 'submitted', waitingReason: undefined, statusLabel: `Connecting to on-machine ${name}`, terminalError: undefined, parts: [], messages: [{ id: messageId, role: 'assistant', partIds: [] }] });
    try {
      if (this.conversationId !== null && this.conversationId !== input.conversationId) await this.closeTransport();
      this.conversationId = input.conversationId;
      const cwd = await localAgentChatDirectory(this.app), threadId = await this.locator.read(input.conversationId);
      vaultRoot = cwd;
      const adapter = this.app.vault?.adapter as { getBasePath?: () => string } | undefined;
      const hostRoot = adapter?.getBasePath?.() ?? resolveAbsoluteVaultPath(adapter, '.');
      vaultRootAlias = hostRoot && hostRoot !== cwd ? hostRoot : undefined;
      homeDirectory = await desktopHost.os().then(os => os.homedir(), () => undefined);
      await input.buildBody?.(controller.signal);
      const images: string[] = [];
      const userText = input.message.parts.map(value => localAgentPromptText(value, images, name)).join('\n');
      const context = this.sources.map(source => {
        if (source.kind === 'image') { images.push(source.data_url); return `Attached image: ${source.path}`; }
        return source.kind === 'text' ? `File: ${source.path}\n${source.content}` : `Read the attached document from this vault path: ${source.path}`;
      }).join('\n\n');
      const history = !threadId ? this.forkHistory() : [];
      const prefix = history.length ? `Previous conversation before this edited message:\n${JSON.stringify(history)}\n\nCurrent message:\n` : '';
      const prompt = `${prefix}${userText}${context ? `\n\nAttached vault context:\n${context}` : ''}`;
      if (prompt.length > 256_000) throw new Error(`This message and its attached context exceed the ${name} input limit.`);
      if (controller.signal.aborted) throw new Error(`${name} response canceled.`);
      await input.beforeSend?.();
      const result = await this.runTurn({ prompt, images, workingDirectory: cwd, threadId }, controller.signal, {
        thread: id => this.locator.write(input.conversationId, id),
        status: label => { if (live() && !this.approvals.size) this.publish({ phase: 'working', statusLabel: label.slice(0, 200) || working }); },
        text, tool, approval,
      });
      if (controller.signal.aborted) throw new Error(`${name} response canceled.`);
      if (result.text.startsWith(receivedText)) text(result.text);
      else if (!receivedText.endsWith(result.text)) text(`${receivedText ? '\n\n' : ''}${result.text}`, receivedText.length);
      finishParts('completed');
      const assistant = message(result.text); persisted = true;
      await this.localOptions.persistAssistant(assistant);
      this.publish({ status: 'completed', phase: 'complete', waitingReason: undefined, statusLabel: `Completed with on-machine ${name}` });
      return { kind: 'completed', snapshot: this.localSnapshot, message: assistant };
    } catch (cause) {
      const cancelled = controller.signal.aborted;
      finishParts(cancelled ? 'cancelled' : 'failed');
      try { await this.closeTransport(); } catch { /* Preserve the original turn failure. */ }
      if (!persisted && this.localSnapshot.parts.length) {
        try { await this.localOptions.persistAssistant(message(receivedText, cancelled ? 'cancelled' : 'failed')); } catch { /* Preserve the original native failure. */ }
      }
      if (cancelled) { this.publish({ status: 'cancelled', phase: 'complete', waitingReason: undefined, statusLabel: `${name} stopped` }); return { kind: 'cancelled', snapshot: this.localSnapshot }; }
      const error = { code: `local_${this.agent}_failed`, message: cause instanceof Error ? cause.message : `${name} could not complete this response.`, retryable: true };
      this.publish({ status: 'failed', phase: 'complete', waitingReason: undefined, terminalError: error, parts: [...this.localSnapshot.parts, { id: `${messageId}_error`, order: this.localSnapshot.parts.length, kind: 'error', error, retryable: true }] });
      return { kind: 'failed', snapshot: this.localSnapshot, error };
    } finally { accepting = false; this.withdrawApprovals(); controller.signal.removeEventListener('abort', stopApprovals); this.sources = []; }
  }
  async cancel(): Promise<void> { this.localController?.abort(); await this.localCompletion; }
  async detach(): Promise<void> { await this.cancel(); await this.closeTransport(); this.localListeners.clear(); }
  disconnect(): void {
    this.localController?.abort();
    // Let native interruption finish before closing stdio; an idle connection can close immediately.
    if (this.localCompletion) void this.localCompletion.finally(() => this.closeTransport()).catch(() => {});
    else void Promise.resolve(this.closeTransport()).catch(() => {});
  }
  respondToApproval(approvalId: string, approved: boolean, source: 'manual' | 'policy' = 'manual', options: ApprovalResponseOptions = {}): boolean {
    const pending = this.approvals.get(approvalId);
    // Native configuration owns policy; a managed policy must never answer a native prompt.
    if (!pending || source !== 'manual' || pending.signal.aborted || this.localController?.signal.aborted) return false;
    pending.finish({ ...options, approved }); return true;
  }
}
