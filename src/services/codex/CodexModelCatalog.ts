import { connectCodex } from './CodexAppServer';
import { describeCodexPermissions } from './CodexPermissions';
import { isRecord } from '../../studio/utils';
export type CodexModel = { model: string; name: string; efforts: string[]; defaultEffort: string; fastTier?: string };
type Catalog = { models: CodexModel[]; permissions: string };
type CatalogRead = { promise: Promise<Catalog>; controller: AbortController; consumers: number };
const pending = new Map<string, CatalogRead>();
let cached: { models: CodexModel[]; at: number } | undefined;
/** Presentation cache only; the installed Codex supplies model availability and options. */
export function readCodexCatalog(cwd: string, signal: AbortSignal): Promise<Catalog> {
  if (signal.aborted) return Promise.reject(new Error('Codex catalog request canceled.'));
  let read = pending.get(cwd);
  if (!read) {
    const controller = new AbortController();
    read = { controller, consumers: 0, promise: loadCodexCatalog(cwd, controller.signal) };
    pending.set(cwd, read);
    const current = read;
    void read.promise.finally(() => { if (pending.get(cwd) === current) pending.delete(cwd); }).catch(() => {});
  }
  const current = read; current.consumers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); current.consumers--;
      if (!current.consumers && pending.get(cwd) === current) { pending.delete(cwd); current.controller.abort(); }
      settle();
    };
    const abort = () => finish(() => reject(new Error('Codex catalog request canceled.')));
    signal.addEventListener('abort', abort, { once: true });
    current.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error instanceof Error ? error : new Error('Could not read the native Codex catalog.'))));
  });
}

async function loadCodexCatalog(cwd: string, signal: AbortSignal): Promise<Catalog> {
  // Only simultaneous readers share this request. Every later read refreshes native
  // permissions, even while the independent model-list presentation cache is warm.
  const connection = await connectCodex(cwd, signal, { error: () => {}, notification: () => {}, request: () => Promise.reject(new Error('Unexpected model-catalog request.')) });
  try {
    const result = await connection.request('config/read', { cwd, includeLayers: false });
    const permissions = describeCodexPermissions(isRecord(result.config) ? result.config : {});
    if (cached && Date.now() - cached.at < 60_000) return { models: cached.models, permissions };
    const models: CodexModel[] = []; let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await connection.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) throw new Error('Codex returned an invalid model catalog.');
      for (const model of result.data.slice(0, 100).filter(isRecord)) {
        if (typeof model.model !== 'string' || model.hidden === true) continue;
        const tiers = Array.isArray(model.serviceTiers) ? model.serviceTiers.filter(isRecord) : [];
        const fast = tiers.find(tier => tier.id === 'fast' || tier.id === 'priority' || /fast/i.test(String(tier.name)));
        models.push({ model: model.model, name: String(model.displayName || model.model),
          efforts: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).filter(isRecord).map(option => String(option.reasoningEffort)),
          defaultEffort: String(model.defaultReasoningEffort || 'high'),
          ...(fast ? { fastTier: String(fast.id) } : Array.isArray(model.additionalSpeedTiers) && model.additionalSpeedTiers.includes('fast') ? { fastTier: 'fast' } : {}),
        });
      }
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
      if (!cursor) break;
      if (page === 4) throw new Error('The native model catalog exceeds the supported page limit.');
    }
    cached = { models, at: Date.now() }; return { models, permissions };
  } finally { connection.close(); }
}
