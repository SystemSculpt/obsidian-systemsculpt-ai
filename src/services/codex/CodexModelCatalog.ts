import { connectCodex } from './CodexAppServer';
import { describeCodexPermissions } from './CodexPermissions';
import { isRecord } from '../../studio/utils';
export type CodexModel = { model: string; name: string; efforts: string[]; defaultEffort: string; fastTier?: string };
let cached: { models: CodexModel[]; at: number } | undefined;
/** Presentation cache only; the installed Codex supplies model availability and options. */
export async function readCodexCatalog(cwd: string, signal: AbortSignal): Promise<{ models: CodexModel[]; permissions: string }> {
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
