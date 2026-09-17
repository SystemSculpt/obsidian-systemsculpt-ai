import type { ChatMessage } from "../../types";
import type { App } from 'obsidian';
import type { ChatSession, AgentRunInput, AgentRunResult } from '../../chat/ChatSession';
import type { AgentConversationSnapshot, AgentTextPart } from '../../chat/ChatConversation';
import { THIN_AGENT_CONTRACT_VERSION, type ThinAgentContextSource, type ThinAgentContextResponse } from '../managed/ThinAgentV1Contract';
import { runLocalCodex } from './LocalCodexClient';
import { answerCodexRequest } from './CodexRequestModal';
import { CodexThreadLocator } from './CodexThreadLocator';
import { codexVaultDirectory, type CodexExecutionOptions } from './CodexExecutionSettings';

/** Chat presentation adapter. Codex owns every model step, tool and durable thread. */
export class CodexChatSession implements ChatSession {
  private localSnapshot: AgentConversationSnapshot = { runId: null, turnId: null, status: 'idle', messages: [], parts: [] };
  private readonly localListeners = new Set<(value: AgentConversationSnapshot) => void>();
  private readonly locator: CodexThreadLocator;
  private localController: AbortController | null = null;
  private localCompletion: Promise<AgentRunResult> | null = null;
  private sources: readonly ThinAgentContextSource[] = [];
  constructor(private readonly app: App, private readonly localOptions: { persistAssistant: (message: ChatMessage) => Promise<void> }, private readonly forkHistory: () => readonly ChatMessage[] = () => [], private readonly executionOptions: () => CodexExecutionOptions = () => ({})) { this.locator = new CodexThreadLocator(app); }
  getSnapshot(): AgentConversationSnapshot { return this.localSnapshot; }
  subscribe(listener: (value: AgentConversationSnapshot) => void): () => void { this.localListeners.add(listener); return () => this.localListeners.delete(listener); }
  private publish(patch: Partial<AgentConversationSnapshot>) {
    this.localSnapshot = { ...this.localSnapshot, ...patch };
    for (const listener of this.localListeners) { try { listener(this.localSnapshot); } catch { /* Presentation must not interrupt Codex. */ } }
  }
  async hydrate(conversationId: string): Promise<void> { await this.locator.read(conversationId); }
  async stageContext(_id: string, sources: readonly ThinAgentContextSource[]): Promise<ThinAgentContextResponse> {
    this.sources = sources;
    return { contract_version: THIN_AGENT_CONTRACT_VERSION, context_ref: 'local-codex-context', expires_at: new Date(Date.now() + 60_000).toISOString(), bytes: 0, sha256: '' };
  }
  start(input: AgentRunInput): Promise<AgentRunResult> {
    if (this.localController) return Promise.reject(new Error('Wait for the current Codex response to finish.'));
    const controller = new AbortController(); this.localController = controller;
    this.sources = [];
    this.localCompletion = this.execute(input, controller).finally(() => { this.localController = null; this.localCompletion = null; });
    return this.localCompletion;
  }
  private async execute(input: AgentRunInput, controller: AbortController): Promise<AgentRunResult> {
    const messageId = `${input.turnId}_assistant`, partId = `${messageId}_text`;
    const part = (text: string, complete = false): AgentTextPart => ({ id: partId, order: 0, kind: 'text', messageId, state: complete ? 'complete' : 'streaming', markdown: text });
    this.publish({ runId: input.turnId, turnId: input.turnId, status: 'running', phase: 'submitted', statusLabel: 'Connecting to on-machine Codex', terminalError: undefined, parts: [], messages: [{ id: messageId, role: 'assistant', partIds: [partId] }] });
    try {
      const cwd = codexVaultDirectory(this.app), threadId = await this.locator.read(input.conversationId);
      await input.buildBody?.(controller.signal);
      const images: string[] = [];
      const text = input.message.parts.map(value => {
        if (value.type === 'text') return value.text;
        if (value.mediaType.startsWith('image/')) { images.push(value.url); return ''; }
        throw new Error('This attachment must be converted to text or an image before sending it to Codex.');
      }).join('\n');
      const context = this.sources.map(source => {
        if (source.kind === 'image') { images.push(source.data_url); return `Attached image: ${source.path}`; }
        return source.kind === "text" ? `File: ${source.path}\n${source.content}` : `Read the attached document from this vault path: ${source.path}`;
      }).join('\n\n');
      const history = !threadId ? this.forkHistory() : [];
      const prefix = history.length ? `Previous conversation before this edited message:\n${JSON.stringify(history)}\n\nCurrent message:\n` : "";
      const prompt = `${prefix}${text}${context ? `\n\nAttached vault context:\n${context}` : ''}`;
      if (prompt.length > 256_000) throw new Error('This message and its attached context exceed the Codex input limit.');
      if (controller.signal.aborted) throw new Error('Codex response canceled.');
      await input.beforeSend?.();
      const result = await runLocalCodex({ ...this.executionOptions(), prompt, images, workingDirectory: cwd, threadId }, controller.signal, {
        thread: id => this.locator.write(input.conversationId, id),
        log: text => this.publish({ phase: 'working', statusLabel: text.startsWith('Command ') ? text.slice(0, 200) : 'Codex is working' }),
        text: text => this.publish({ phase: 'working', parts: [part(text)] }),
        request: async (method, params, signal) => {
          this.publish({ status: 'waiting', phase: 'waiting', statusLabel: 'Codex needs your input' });
          try { return await answerCodexRequest(this.app, method, params, signal); }
          finally { this.publish({ status: 'running', phase: 'working', statusLabel: 'Codex is working' }); }
        },
      });
      const message = { role: 'assistant' as const, content: result.text, message_id: messageId };
      await this.localOptions.persistAssistant(message);
      this.publish({ status: 'completed', phase: 'complete', statusLabel: 'Completed with on-machine Codex', parts: [part(result.text, true)] });
      return { kind: 'completed', snapshot: this.localSnapshot, message };
    } catch (cause) {
      if (controller.signal.aborted) { this.publish({ status: 'cancelled', phase: 'complete', statusLabel: 'Codex stopped' }); return { kind: 'cancelled', snapshot: this.localSnapshot }; }
      const error = { code: 'local_codex_failed', message: cause instanceof Error ? cause.message : 'Codex could not complete this response.', retryable: true };
      this.publish({ status: 'failed', phase: 'complete', terminalError: error, parts: [...this.localSnapshot.parts, { id: `${messageId}_error`, order: 1, kind: 'error', error, retryable: true }] });
      return { kind: 'failed', snapshot: this.localSnapshot, error };
    } finally { this.sources = []; }
  }
  async cancel(): Promise<void> { this.localController?.abort(); await this.localCompletion; }
  async detach(): Promise<void> { await this.cancel(); this.localListeners.clear(); }
  disconnect(): void { this.localController?.abort(); }
  respondToApproval(): boolean { return false; }
}
