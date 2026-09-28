import { runLocalCodex, type CodexCallbacks, type CodexRequest, type CodexResult } from './LocalCodexClient';

const active = new Map<string, { controller: AbortController; threadId: string }>();
export function codexRunKey(projectId: string, nodeId: string): string { return JSON.stringify([projectId, nodeId]); }
export function getStudioCodexRun(key: string): { threadId: string } | null {
  const run = active.get(key); return run ? { threadId: run.threadId } : null;
}
export function stopStudioCodexRun(key: string): void { active.get(key)?.controller.abort(); }

/** Tracks mounted execution transports, never schedules or continues an agent. */
export class StudioCodexRuns {
  private readonly owned = new Set<string>();
  async run(key: string, input: CodexRequest, signal: AbortSignal, callbacks: CodexCallbacks): Promise<CodexResult> {
    if (active.has(key)) throw new Error('This Codex card is already running.');
    const controller = new AbortController(), state = { controller, threadId: '' };
    active.set(key, state); this.owned.add(key);
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try { return await runLocalCodex(input, controller.signal, { ...callbacks, thread: id => { state.threadId = id; return callbacks.thread(id); } }); }
    finally { signal.removeEventListener('abort', abort); active.delete(key); this.owned.delete(key); }
  }
  dispose(): void { for (const key of this.owned) stopStudioCodexRun(key); }
}
