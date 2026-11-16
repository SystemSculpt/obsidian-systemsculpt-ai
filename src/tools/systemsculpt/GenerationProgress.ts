/**
 * Live progress of the SystemSculpt generations running in this Obsidian
 * session, so Chat can show more than a spinner while a call waits. Only what
 * the hosted job already reports (queued or processing, its typical length)
 * and the Studio step that is running; nothing is persisted.
 *
 * Calls are keyed by tool and request rather than call ID: Claude Code's MCP
 * bridge gives the tool no call ID, and the same key is computed from the
 * arguments Chat shows.
 */

export type GenerationProgress = Readonly<{
  /** Date.now() when the call started here. */
  startedAt: number;
  /** The hosted job's status: "queued" or "processing". */
  status?: string;
  /** How long this kind of job usually takes, when the server says. */
  typicalDurationMs?: number;
  /** For a Studio run: the step that is running now. */
  step?: string;
}>;

const running = new Map<string, GenerationProgress>();
/** Calls already holding a key, so a repeated request keeps the first start time. */
const holders = new Map<string, number>();

/** The key for a call's tool and arguments (prompt, or workflow and node). */
export function generationKey(tool: string, args: Readonly<Record<string, unknown>>): string | null {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if ((tool === "generate_image" || tool === "generate_video") && prompt) return `${tool}\n${prompt}`;
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (tool === "studio_run_workflow" && path) return `${tool}\n${path}\n${typeof args.node_id === "string" ? args.node_id.trim() : ""}`;
  return null;
}

/** Marks a call as started; returns the function that ends it. */
export function beginGeneration(key: string | null, now = Date.now()): () => void {
  if (!key) return () => undefined;
  if (!running.has(key)) running.set(key, { startedAt: now });
  holders.set(key, (holders.get(key) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (holders.get(key) ?? 1) - 1;
    if (left > 0) { holders.set(key, left); return; }
    holders.delete(key);
    running.delete(key);
  };
}

export function updateGeneration(key: string | null, patch: Partial<Omit<GenerationProgress, "startedAt">>): void {
  const current = key ? running.get(key) : undefined;
  if (key && current) running.set(key, { ...current, ...patch });
}

export function generationProgress(key: string | null): GenerationProgress | undefined {
  return key ? running.get(key) : undefined;
}
