export async function fetchJson(
  url: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const controller = new AbortController();
  const timeoutMs = init?.timeoutMs ?? 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...(init ?? {}), signal: controller.signal });
    const text = await resp.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: resp.ok, status: resp.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

