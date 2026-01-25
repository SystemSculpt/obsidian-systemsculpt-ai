import { httpRequest } from '../../utils/httpClient';

export type LocalProviderType = 'ollama' | 'lmstudio';

export interface LocalEmbeddingOption {
  type: LocalProviderType;
  /** Full embeddings endpoint URL */
  endpoint: string;
  /** Model identifier/name */
  model: string;
  /** Detected embedding vector dimension (best-effort) */
  dimension?: number;
  /** Human-friendly summary */
  label: string;
}

/** Simple heuristic to prioritize likely embedding models */
const isLikelyEmbeddingModel = (modelId: string): boolean => {
  const id = modelId.toLowerCase();
  return (
    id.includes('embed') ||
    id.includes('nomic') ||
    id.includes('bge') ||
    id.includes('e5') ||
    id.includes('gte') ||
    id.includes('minilm') ||
    id.includes('mpnet') ||
    id.includes('text-embedding')
  );
};

async function tryParseJson(text: string | undefined): Promise<any | null> {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function scanLMStudio(): Promise<LocalEmbeddingOption[]> {
  const base = 'http://localhost:1234';
  const modelsUrl = `${base}/v1/models`;
  const embeddingsUrl = `${base}/v1/embeddings`;
  try {
    const resp = await httpRequest({ url: modelsUrl, method: 'GET', headers: { 'Content-Type': 'application/json' } });
    if (!resp || resp.status !== 200) return [];
    const data = resp.json ?? (await tryParseJson(resp.text));
    const list: string[] = Array.isArray(data?.data)
      ? data.data.map((m: any) => m.id).filter((id: any) => typeof id === 'string')
      : [];
    const candidates = list.filter(isLikelyEmbeddingModel).slice(0, 6);

    const results: LocalEmbeddingOption[] = [];
    for (const model of candidates) {
      try {
        const test = await httpRequest({
          url: embeddingsUrl,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: 'hello', encoding_format: 'float' })
        });
        if (test.status === 200) {
          const tj = test.json ?? (await tryParseJson(test.text));
          const vec = Array.isArray(tj?.data) && tj.data[0]?.embedding;
          const dim = Array.isArray(vec) ? vec.length : undefined;
          results.push({
            type: 'lmstudio',
            endpoint: embeddingsUrl,
            model,
            dimension: dim,
            label: `LM Studio • ${model}${dim ? ` • ${dim}d` : ''}`
          });
        }
      } catch {}
    }
    return results;
  } catch {
    return [];
  }
}

async function scanOllama(): Promise<LocalEmbeddingOption[]> {
  const base = 'http://localhost:11434';
  const tagsUrl = `${base}/api/tags`;
  const embeddingsUrl = `${base}/api/embeddings`;
  try {
    const resp = await httpRequest({ url: tagsUrl, method: 'GET', headers: { 'Content-Type': 'application/json' } });
    if (!resp || resp.status !== 200) return [];
    const data = resp.json ?? (await tryParseJson(resp.text));
    const list: string[] = Array.isArray(data?.models)
      ? data.models.map((m: any) => m.name).filter((n: any) => typeof n === 'string')
      : [];
    const candidates = list.filter(isLikelyEmbeddingModel);
    const limited = candidates.length > 0 ? candidates.slice(0, 6) : ['nomic-embed-text', 'all-minilm'];

    const results: LocalEmbeddingOption[] = [];
    for (const model of limited) {
      try {
        const test = await httpRequest({
          url: embeddingsUrl,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: 'hello' })
        });
        if (test.status === 200) {
          const tj = test.json ?? (await tryParseJson(test.text));
          const vec = Array.isArray(tj?.embedding) ? tj.embedding : (Array.isArray(tj?.data) ? tj.data[0]?.embedding : undefined);
          const dim = Array.isArray(vec) ? vec.length : undefined;
          results.push({
            type: 'ollama',
            endpoint: embeddingsUrl,
            model,
            dimension: dim,
            label: `Ollama • ${model}${dim ? ` • ${dim}d` : ''}`
          });
        }
      } catch {}
    }
    return results;
  } catch {
    return [];
  }
}

export async function scanLocalEmbeddingProviders(): Promise<LocalEmbeddingOption[]> {
  const [lmstudio, ollama] = await Promise.all([scanLMStudio(), scanOllama()]);
  // Deduplicate by endpoint+model
  const seen = new Set<string>();
  const out: LocalEmbeddingOption[] = [];
  for (const item of [...lmstudio, ...ollama]) {
    const key = `${item.endpoint}::${item.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}


