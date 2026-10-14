import { runLocalCodex, type CodexCallbacks, type CodexRequest, type CodexResult } from './LocalCodexClient';
import { LOCAL_AGENTS, type LocalAgentId } from './LocalAgents';

const active = new Map<string, { controller: AbortController; threadId: string; agent: LocalAgentId }>();
export function codexRunKey(projectId: string, nodeId: string): string { return JSON.stringify([projectId, nodeId]); }
export function getStudioCodexRun(key: string): { threadId: string; agent: LocalAgentId } | null {
  const run = active.get(key); return run ? { threadId: run.threadId, agent: run.agent } : null;
}
export function stopStudioCodexRun(key: string): void { active.get(key)?.controller.abort(); }

/** Tracks mounted execution transports, never schedules or continues an agent. */
export class StudioCodexRuns {
  private readonly owned = new Set<string>();
  run(key: string, input: CodexRequest, signal: AbortSignal, callbacks: CodexCallbacks): Promise<CodexResult> {
    return this.track(key, 'codex', signal, (runSignal, thread) => runLocalCodex(input, runSignal, { ...callbacks, thread: id => { thread(id); return callbacks.thread(id); } }));
  }
  /** Runs one on-machine agent turn for a card, stoppable from the card while it runs. */
  async track<T>(key: string, agent: LocalAgentId, signal: AbortSignal, start: (signal: AbortSignal, thread: (id: string) => void) => Promise<T>): Promise<T> {
    if (active.has(key)) throw new Error(`This ${LOCAL_AGENTS[agent]} card is already running.`);
    const controller = new AbortController(), state = { controller, threadId: '', agent };
    active.set(key, state); this.owned.add(key);
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try { return await start(controller.signal, id => { state.threadId = id; }); }
    finally { signal.removeEventListener('abort', abort); active.delete(key); this.owned.delete(key); }
  }
  dispose(): void { for (const key of this.owned) stopStudioCodexRun(key); }
}
