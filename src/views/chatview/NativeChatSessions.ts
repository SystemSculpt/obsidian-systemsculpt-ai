import type { LocalAgentChatSession } from '../../services/codex/LocalAgentChatSession';
import type { AgentTranscriptRepository } from './AgentTranscriptRepository';

export type NativeChatSession = Readonly<{
  session: LocalAgentChatSession;
  transcript: AgentTranscriptRepository;
}>;

type Entry = NativeChatSession & {
  viewers: Set<object>;
  unsubscribe: () => void;
  closing?: Promise<void>;
};

/** Plugin-owned native connections and their original vault transcript, not an agent runtime. */
export class NativeChatSessions {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  retain(chatId: string, session: LocalAgentChatSession, transcript: AgentTranscriptRepository, viewer: object): void {
    if (this.disposed) throw new Error('The plugin is unloading.');
    const existing = this.entries.get(chatId);
    if (existing) {
      if (existing.session !== session || existing.closing) throw new Error('This chat already has a native session.');
      existing.viewers.add(viewer);
      return;
    }
    const entry: Entry = { session, transcript, viewers: new Set([viewer]), unsubscribe: () => {} };
    this.entries.set(chatId, entry);
    entry.unsubscribe = session.subscribe(() => {
      if (!entry.viewers.size && !this.isWorking(chatId)) void this.close(chatId, entry).catch(() => {});
    });
  }

  get(chatId: string): NativeChatSession | undefined {
    const entry = this.entries.get(chatId);
    return entry?.closing ? undefined : entry;
  }

  attach(chatId: string, viewer: object): NativeChatSession | undefined {
    const entry = this.entries.get(chatId);
    if (!entry || entry.closing || this.disposed) return undefined;
    entry.viewers.add(viewer);
    return entry;
  }

  isWorking(chatId: string): boolean {
    const status = this.entries.get(chatId)?.session.getSnapshot().status;
    return status === 'running' || status === 'waiting';
  }

  /** Only relinquishes presentation; a running turn keeps its connection and save target. */
  async release(session: LocalAgentChatSession, viewer: object): Promise<void> {
    for (const [chatId, entry] of this.entries) {
      if (entry.session !== session) continue;
      entry.viewers.delete(viewer);
      if (!entry.viewers.size && !this.isWorking(chatId)) await this.close(chatId, entry);
      return;
    }
    await session.detach();
  }

  async delete(chatId: string): Promise<void> {
    const entry = this.entries.get(chatId);
    if (entry) await this.close(chatId, entry);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.entries].map(([chatId, entry]) => this.close(chatId, entry)));
  }

  private close(chatId: string, entry: Entry): Promise<void> {
    entry.closing ??= (async () => {
      entry.unsubscribe();
      await entry.session.detach();
      await entry.transcript.idle();
      if (this.entries.get(chatId) === entry) this.entries.delete(chatId);
    })();
    return entry.closing;
  }
}

const registries = new WeakMap<object, NativeChatSessions>();

export function nativeChatSessions(owner: object): NativeChatSessions {
  let sessions = registries.get(owner);
  if (!sessions) { sessions = new NativeChatSessions(); registries.set(owner, sessions); }
  return sessions;
}
