import type { ChatMessage } from "../../types";
import type { App } from 'obsidian';
import type { ChatSession, AgentRunInput, AgentRunResult } from '../../chat/ChatSession';
import type { AgentConversationSnapshot, AgentTextPart } from '../../chat/ChatConversation';
import { THIN_AGENT_CONTRACT_VERSION, type MeasuredThinAgentContext, type ThinAgentContextSource, type ThinAgentContextResponse } from '../managed/ThinAgentV1Contract';
import { CodexThreadLocator } from './CodexThreadLocator';
import { codexVaultDirectory } from './CodexExecutionSettings';
import { LOCAL_AGENTS, type LocalAgentId } from './LocalAgents';

export type LocalAgentTurn = { prompt: string; images: string[]; workingDirectory: string; threadId?: string };
export type LocalAgentTurnEvents = {
  /** Persist the native thread identity before the agent continues. */
  thread: (threadId: string) => Promise<void>;
  status: (label: string) => void;
  text: (text: string) => void;
  /** Wraps a prompt that waits on the person. */
  waitFor: <T>(question: () => Promise<T>) => Promise<T>;
};
/** One native turn. The agent alone owns authentication, tools, reasoning, permissions and history. */
export type LocalAgentTurnRunner = (turn: LocalAgentTurn, signal: AbortSignal, events: LocalAgentTurnEvents) => Promise<{ text: string }>;

/** Chat presentation adapter shared by on-machine agents. The agent owns every model step, tool and durable thread. */
export class LocalAgentChatSession implements ChatSession {
  private localSnapshot: AgentConversationSnapshot = { runId: null, turnId: null, status: 'idle', messages: [], parts: [] };
  private readonly localListeners = new Set<(value: AgentConversationSnapshot) => void>();
  private readonly locator: CodexThreadLocator;
  private localController: AbortController | null = null;
  private localCompletion: Promise<AgentRunResult> | null = null;
  private sources: readonly ThinAgentContextSource[] = [];
  readonly agentName: string;
  constructor(protected readonly app: App, readonly agent: LocalAgentId, private readonly localOptions: { persistAssistant: (message: ChatMessage) => Promise<void> }, protected readonly forkHistory: () => readonly ChatMessage[], private readonly runTurn: LocalAgentTurnRunner) {
    this.locator = new CodexThreadLocator(app, agent); this.agentName = LOCAL_AGENTS[agent];
  }
  getSnapshot(): AgentConversationSnapshot { return this.localSnapshot; }
  subscribe(listener: (value: AgentConversationSnapshot) => void): () => void { this.localListeners.add(listener); return () => this.localListeners.delete(listener); }
  private publish(patch: Partial<AgentConversationSnapshot>) {
    this.localSnapshot = { ...this.localSnapshot, ...patch };
    for (const listener of this.localListeners) { try { listener(this.localSnapshot); } catch { /* Presentation must not interrupt the agent. */ } }
  }
  async hydrate(conversationId: string): Promise<void> { await this.locator.read(conversationId); }
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
    const name = this.agentName, working = `${name} is working`;
    const messageId = `${input.turnId}_assistant`, partId = `${messageId}_text`;
    const part = (text: string, complete = false): AgentTextPart => ({ id: partId, order: 0, kind: 'text', messageId, state: complete ? 'complete' : 'streaming', markdown: text });
    this.publish({ runId: input.turnId, turnId: input.turnId, status: 'running', phase: 'submitted', statusLabel: `Connecting to on-machine ${name}`, terminalError: undefined, parts: [], messages: [{ id: messageId, role: 'assistant', partIds: [partId] }] });
    try {
      const cwd = codexVaultDirectory(this.app), threadId = await this.locator.read(input.conversationId);
      await input.buildBody?.(controller.signal);
      const images: string[] = [];
      const text = input.message.parts.map(value => {
        if (value.type === 'text') return value.text;
        if (value.mediaType.startsWith('image/')) { images.push(value.url); return ''; }
        throw new Error(`This attachment must be converted to text or an image before sending it to ${name}.`);
      }).join('\n');
      const context = this.sources.map(source => {
        if (source.kind === 'image') { images.push(source.data_url); return `Attached image: ${source.path}`; }
        return source.kind === "text" ? `File: ${source.path}\n${source.content}` : `Read the attached document from this vault path: ${source.path}`;
      }).join('\n\n');
      const history = !threadId ? this.forkHistory() : [];
      const prefix = history.length ? `Previous conversation before this edited message:\n${JSON.stringify(history)}\n\nCurrent message:\n` : "";
      const prompt = `${prefix}${text}${context ? `\n\nAttached vault context:\n${context}` : ''}`;
      if (prompt.length > 256_000) throw new Error(`This message and its attached context exceed the ${name} input limit.`);
      if (controller.signal.aborted) throw new Error(`${name} response canceled.`);
      await input.beforeSend?.();
      const result = await this.runTurn({ prompt, images, workingDirectory: cwd, threadId }, controller.signal, {
        thread: id => this.locator.write(input.conversationId, id),
        status: label => this.publish({ phase: 'working', statusLabel: label.slice(0, 200) || working }),
        text: text => this.publish({ phase: 'working', parts: [part(text)] }),
        waitFor: async question => {
          this.publish({ status: 'waiting', phase: 'waiting', statusLabel: `${name} needs your input` });
          try { return await question(); }
          finally { this.publish({ status: 'running', phase: 'working', statusLabel: working }); }
        },
      });
      const message = { role: 'assistant' as const, content: result.text, message_id: messageId };
      await this.localOptions.persistAssistant(message);
      this.publish({ status: 'completed', phase: 'complete', statusLabel: `Completed with on-machine ${name}`, parts: [part(result.text, true)] });
      return { kind: 'completed', snapshot: this.localSnapshot, message };
    } catch (cause) {
      if (controller.signal.aborted) { this.publish({ status: 'cancelled', phase: 'complete', statusLabel: `${name} stopped` }); return { kind: 'cancelled', snapshot: this.localSnapshot }; }
      const error = { code: `local_${this.agent}_failed`, message: cause instanceof Error ? cause.message : `${name} could not complete this response.`, retryable: true };
      this.publish({ status: 'failed', phase: 'complete', terminalError: error, parts: [...this.localSnapshot.parts, { id: `${messageId}_error`, order: 1, kind: 'error', error, retryable: true }] });
      return { kind: 'failed', snapshot: this.localSnapshot, error };
    } finally { this.sources = []; }
  }
  async cancel(): Promise<void> { this.localController?.abort(); await this.localCompletion; }
  async detach(): Promise<void> { await this.cancel(); this.localListeners.clear(); }
  disconnect(): void { this.localController?.abort(); }
  respondToApproval(): boolean { return false; }
}
