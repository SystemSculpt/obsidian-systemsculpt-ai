import { httpRequest, isHostTemporarilyDisabled } from '../../utils/httpClient';

export type LocalLLMType = 'ollama' | 'lmstudio';

export interface LocalLLMOption {
  type: LocalLLMType;
  endpoint: string;
  models: string[];
  label: string;
}

async function tryParseJson(text: string | undefined): Promise<any | null> {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function scanLMStudio(): Promise<LocalLLMOption[]> {
  const base = 'http://localhost:1234';
  const modelsUrl = `${base}/v1/models`;
  try {
    // Respect circuit breaker to avoid console spam when LM Studio isn't running
    const disabled = isHostTemporarilyDisabled(modelsUrl);
    if (disabled.disabled) return [];
    const resp = await httpRequest({ url: modelsUrl, method: 'GET', headers: { 'Content-Type': 'application/json' } });
    if (!resp || resp.status !== 200) return [];
    const data = resp.json ?? (await tryParseJson(resp.text));
    const list: string[] = Array.isArray(data?.data)
      ? data.data.map((m: any) => m.id).filter((id: any) => typeof id === 'string')
      : [];
    if (list.length === 0) return [];
    return [{
      type: 'lmstudio',
      endpoint: `${base}/v1`,
      models: list,
      label: `LM Studio • ${list.length} model${list.length === 1 ? '' : 's'}`
    }];
  } catch {
    return [];
  }
}

async function scanOllama(): Promise<LocalLLMOption[]> {
  const base = 'http://localhost:11434';
  const modelsUrl = `${base}/v1/models`;
  const tagsFallbackUrl = `${base}/api/tags`;
  try {
    // Skip probing when host is temporarily disabled
    const disabledA = isHostTemporarilyDisabled(modelsUrl);
    const disabledB = isHostTemporarilyDisabled(tagsFallbackUrl);
    if (disabledA.disabled && disabledB.disabled) return [];
    let list: string[] = [];
    try {
      if (!disabledA.disabled) {
        const resp = await httpRequest({ url: modelsUrl, method: 'GET', headers: { 'Content-Type': 'application/json' } });
        if (resp && resp.status === 200) {
          const data = resp.json ?? (await tryParseJson(resp.text));
          list = Array.isArray(data?.data)
            ? data.data.map((m: any) => m.id).filter((id: any) => typeof id === 'string')
            : [];
        }
      }
    } catch {}
    if (list.length === 0) {
      try {
        if (!disabledB.disabled) {
          const tags = await httpRequest({ url: tagsFallbackUrl, method: 'GET', headers: { 'Content-Type': 'application/json' } });
          if (tags && tags.status === 200) {
            const data = tags.json ?? (await tryParseJson(tags.text));
            list = Array.isArray(data?.models)
              ? data.models.map((m: any) => m.name).filter((n: any) => typeof n === 'string')
              : [];
          }
        }
      } catch {}
    }
    if (list.length === 0) return [];
    return [{
      type: 'ollama',
      endpoint: `${base}/v1`,
      models: list,
      label: `Ollama • ${list.length} model${list.length === 1 ? '' : 's'}`
    }];
  } catch {
    return [];
  }
}

export async function scanLocalLLMProviders(): Promise<LocalLLMOption[]> {
  const [lmstudio, ollama] = await Promise.all([scanLMStudio(), scanOllama()]);
  const seen = new Set<string>();
  const out: LocalLLMOption[] = [];
  for (const item of [...lmstudio, ...ollama]) {
    const key = `${item.type}::${item.endpoint}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}


