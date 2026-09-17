type RecordValue = Record<string, unknown>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function record(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function timestamp(value: RecordValue): string { return String(value.finishedAt || value.updatedAt || value.startedAt || ""); }

/** Run summaries and node caches are indexes over independently published
 * results. Combining them must not discard another producer's entries. */
export function reconcileStudioSupportDocument(path: string, localBytes: Uint8Array, externalBytes: Uint8Array): Uint8Array | null {
  if (path !== "support/runs/index.json" && path !== "support/cache/node-results.json") return null;
  try {
    const local: unknown = JSON.parse(decoder.decode(localBytes));
    const external: unknown = JSON.parse(decoder.decode(externalBytes));
    let result: unknown;
    if (path === "support/runs/index.json") {
      if (!Array.isArray(local) || !Array.isArray(external)) return null;
      const entries = new Map<string, RecordValue>();
      for (const value of [...external, ...local]) {
        if (!record(value) || typeof value.runId !== "string") return null;
        const previous = entries.get(value.runId);
        if (!previous || timestamp(value) >= timestamp(previous)) entries.set(value.runId, value);
      }
      result = [...entries.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || String(a.runId).localeCompare(String(b.runId)));
    } else {
      if (!record(local) || !record(external) || local.schema !== "studio.node-cache.v1" || external.schema !== local.schema || external.projectId !== local.projectId || !record(local.entries) || !record(external.entries)) return null;
      const entries: Record<string, unknown> = { ...external.entries };
      for (const [id, value] of Object.entries(local.entries)) {
        const previous = entries[id];
        if (!record(value)) return null;
        if (!record(previous) || timestamp(value) > timestamp(previous) || (timestamp(value) === timestamp(previous) && String(value.runId) >= String(previous.runId))) Object.defineProperty(entries, id, { value, enumerable: true, configurable: true, writable: true });
      }
      result = { ...local, updatedAt: [String(local.updatedAt), String(external.updatedAt)].sort()[1], entries };
    }
    return encoder.encode(`${JSON.stringify(result, null, 2)}\n`);
  } catch { return null; }
}
